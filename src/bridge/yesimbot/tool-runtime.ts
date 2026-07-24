/**
 * YesImBot 工具运行时（ToolService 格式）。
 *
 * 将 YESIMBOT_TOOL_DEFINITIONS 中定义的工具转换为 ToolService 可执行的
 * ToolDefinition，提供 execute() 函数实现。
 *
 * 与 sticker-manager 的 @Tool 装饰器产生完全相同的 execute 签名和返回值格式。
 *
 * 关键适配点（vs 旧的 AI SDK 格式）：
 * 1. execute 签名：({ session, ...params }) => Promise<ToolExecuteResult>
 * 2. 返回值：{ status: "success"|"error", result|error }
 * 3. parameters 直接使用 Koishi Schema（非 Zod + jsonSchema 包装）
 * 4. 工具实例存入 Map<string, ToolDefinitionForToolService>
 */

import { h } from 'koishi'

import { calculateGenerationCost } from '../../shared/billing.js'
import type { Config } from '../../shared/config.js'
import type {
  ImageRequestContext,
  ModelMappingConfig,
  ResolvedStyleConfig,
  StyleMatchCandidate,
} from '../../shared/types.js'
import type { AiImageGeneratorService } from '../../service/AiImageGeneratorService.js'
import type {
  ToolDefinitionForToolService,
  ToolExecuteResult,
  ToolSessionLike,
} from './runtime.js'
import type { YesImBotToolDefinition } from './tool-definitions.js'

// ---------------------------------------------------------------------------
// Success / Failed 辅助函数（与 ToolService helpers.js 返回格式一致）
// ---------------------------------------------------------------------------

function Success(result: unknown, metadata?: unknown): ToolExecuteResult {
  return { status: 'success', result, metadata }
}

function Failed(error: string | { name: string; message: string; retryable?: boolean }, metadata?: unknown): ToolExecuteResult {
  if (typeof error === 'string') {
    return { status: 'error', error: { name: 'ToolError', message: error }, metadata }
  }
  return { status: 'error', error, metadata }
}

// ---------------------------------------------------------------------------
// 工具实例创建（构造 ToolDefinitionForToolService）
// ---------------------------------------------------------------------------

export function createYesImBotToolForToolService(
  definition: YesImBotToolDefinition,
  aiGenerator: AiImageGeneratorService,
  config: Config,
  logger: (...args: any[]) => void,
): ToolDefinitionForToolService {
  const execute = async (args: { session: ToolSessionLike; [key: string]: unknown }): Promise<ToolExecuteResult> => {
    const session = args.session

    try {
      switch (definition.name) {
        case 'aigc_generate_image':
          return await runGenerateImageTool(args, session, aiGenerator, config, logger)
        case 'aigc_edit_image':
          return await runEditImageTool(args, session, aiGenerator, config, logger)
        case 'aigc_apply_style_preset':
          return await runStylePresetTool(args, session, aiGenerator, config, logger)
        case 'aigc_get_quota':
          return await runGetQuotaTool(session, aiGenerator)
        case 'aigc_list_styles':
          return runListStylesTool(args, aiGenerator)
        default:
          return Failed(`unsupported tool: ${definition.name}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger('YesImBot tool execute failed: %s, error: %s', definition.name, message)
      return Failed(message)
    }
  }

  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    execute,
    promptSnippet: definition.promptSnippet,
    promptGuidelines: definition.promptGuidelines,
  }
}

// ---------------------------------------------------------------------------
// 工具执行函数
// ---------------------------------------------------------------------------

async function runGenerateImageTool(
  args: Record<string, unknown>,
  session: ToolSessionLike,
  aiGenerator: AiImageGeneratorService,
  config: Config,
  logger: (...args: any[]) => void,
): Promise<ToolExecuteResult> {
  return withImageTaskLock(session, aiGenerator, async (requestId) => {
    const prompt = expectString(args.prompt, 'prompt')
    const { requestContext, generationCost } = buildRequestContextAndCost(args, config)

    const reservation = await aiGenerator.reserveCredits(session.userId, session.username || session.userId, requestId, generationCost, session.platform || undefined)
    if (!reservation.allowed) {
      return Failed(reservation.message || '积分不足。')
    }

    const images = await aiGenerator.requestProviderImages(
      prompt,
      [],
      generationCost.numImages,
      requestContext,
    )

    aiGenerator.rememberGeneratedImages({
      session: session as any,
      imageUrls: images,
      prompt,
      requestContext,
      stylePreset: 'aigc_generate_image',
    })

    const usage = await aiGenerator.settleReservation(requestId, images.length, 'aigc_generate_image', { routeId: requestContext.routeId ?? null, modelId: requestContext.modelId ?? null })

    return Success({
      message: `生成完成！共生成 ${images.length} 张图像。`,
      images: images.map(summarizeImageUrl),
      remainingCredits: aiGenerator.formatCredits((await aiGenerator.getQuotaSummary(session.userId, session.username || session.userId)).totalAvailable),
    })
  })
}

async function runEditImageTool(
  args: Record<string, unknown>,
  session: ToolSessionLike,
  aiGenerator: AiImageGeneratorService,
  config: Config,
  logger: (...args: any[]) => void,
): Promise<ToolExecuteResult> {
  return withImageTaskLock(session, aiGenerator, async (requestId) => {
    const prompt = expectString(args.prompt, 'prompt')
    const referenceMode =
      typeof args.referenceMode === 'string' ? args.referenceMode : 'explicit'
    const imageUrls = resolveReferenceImages(
      referenceMode,
      args,
      session,
      aiGenerator,
    )
    if (!imageUrls.length) {
      return Failed('未能解析到参考图片。请提供图片 URL 或在消息中附带图片。')
    }

    const { requestContext, generationCost } = buildRequestContextAndCost(args, config)

    const reservation = await aiGenerator.reserveCredits(session.userId, session.username || session.userId, requestId, generationCost, session.platform || undefined)
    if (!reservation.allowed) {
      return Failed(reservation.message || '积分不足。')
    }

    const images = await aiGenerator.requestProviderImages(
      prompt,
      imageUrls,
      generationCost.numImages,
      requestContext,
    )

    const conversationId = aiGenerator.buildSessionConversationId(session as any)
    aiGenerator.rememberGeneratedImages({
      session: session as any,
      conversationId,
      imageUrls: images,
      prompt,
      requestContext,
      stylePreset: 'aigc_edit_image',
      parentRecordId:
        referenceMode === 'last_generated' && conversationId
          ? aiGenerator.getConversationImageContext(conversationId)?.lastGenerated?.id
          : undefined,
    })

    const usage = await aiGenerator.settleReservation(requestId, images.length, 'aigc_edit_image', { routeId: requestContext.routeId ?? null, modelId: requestContext.modelId ?? null })

    return Success({
      message: `编辑完成！共生成 ${images.length} 张图像。`,
      images: images.map(summarizeImageUrl),
      remainingCredits: aiGenerator.formatCredits((await aiGenerator.getQuotaSummary(session.userId, session.username || session.userId)).totalAvailable),
    })
  })
}

async function runStylePresetTool(
  args: Record<string, unknown>,
  session: ToolSessionLike,
  aiGenerator: AiImageGeneratorService,
  config: Config,
  logger: (...args: any[]) => void,
): Promise<ToolExecuteResult> {
  return withImageTaskLock(session, aiGenerator, async (requestId) => {
    const resolvedStyle = resolveRequestedStylePreset(args, aiGenerator)
    if ('error' in resolvedStyle) {
      return Failed(resolvedStyle.error)
    }
    const { preset } = resolvedStyle

    const promptAdditions =
      typeof args.promptAdditions === 'string' ? args.promptAdditions.trim() : ''
    const prompt = [preset.prompt, promptAdditions].filter(Boolean).join(' - ')
    const referenceMode =
      typeof args.referenceMode === 'string' ? args.referenceMode : 'none'
    const imageUrls =
      referenceMode === 'none'
        ? []
        : resolveReferenceImages(referenceMode, args, session, aiGenerator)

    if (referenceMode !== 'none' && !imageUrls.length) {
      return Failed('未能解析到参考图片。')
    }

    const { requestContext, generationCost } = buildRequestContextAndCost(args, config)

    const reservation = await aiGenerator.reserveCredits(session.userId, session.username || session.userId, requestId, generationCost, session.platform || undefined)
    if (!reservation.allowed) {
      return Failed(reservation.message || '积分不足。')
    }

    const images = await aiGenerator.requestProviderImages(
      prompt,
      imageUrls,
      generationCost.numImages,
      requestContext,
    )

    aiGenerator.rememberGeneratedImages({
      session: session as any,
      imageUrls: images,
      prompt,
      requestContext,
      stylePreset: preset.commandName,
    })

    const usage = await aiGenerator.settleReservation(requestId, images.length, preset.commandName, { routeId: requestContext.routeId ?? null, modelId: requestContext.modelId ?? null })

    return Success({
      message: `已应用「${preset.commandName}」风格，生成 ${images.length} 张图像。`,
      images: images.map(summarizeImageUrl),
      remainingCredits: aiGenerator.formatCredits((await aiGenerator.getQuotaSummary(session.userId, session.username || session.userId)).totalAvailable),
    })
  })
}

async function runGetQuotaTool(
  session: ToolSessionLike,
  aiGenerator: AiImageGeneratorService,
): Promise<ToolExecuteResult> {
  const summary = await aiGenerator.getQuotaSummary(
    session.userId,
    session.username || session.userId,
  )
  return Success({
    userName: summary.userName || session.userId,
    dailyFreeRemaining: aiGenerator.formatCredits(summary.trialRemaining),
    purchasedCredits: aiGenerator.formatCredits(summary.purchasedCredits),
    totalAvailable: aiGenerator.formatCredits(summary.totalAvailable),
    totalImagesGenerated: summary.totalImagesGenerated,
    totalConsumedCredits: aiGenerator.formatCredits(summary.totalConsumedCredits),
    totalGrantedCredits: aiGenerator.formatCredits(summary.totalGrantedCredits),
  })
}

function runListStylesTool(
  args: Record<string, unknown>,
  aiGenerator: AiImageGeneratorService,
): ToolExecuteResult {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  const allStyles = aiGenerator.listStylePresets()

  let styles = allStyles
  if (query) {
    const matches = aiGenerator.matchStylePresets(query, 20)
    styles = matches.map((m) => m.style)
  }

  if (!styles.length) {
    return Success({
      styles: [],
      message: query ? `未找到匹配「${query}」的风格预设。` : '暂无可用风格预设。',
    })
  }

  return Success({
    styles: styles.map((s) => ({
      commandName: s.commandName,
      description: s.description || '',
      category: s.category || '',
    })),
    message: query
      ? `找到 ${styles.length} 个匹配「${query}」的风格预设`
      : `共 ${styles.length} 个可用风格预设`,
  })
}

// ---------------------------------------------------------------------------
// 请求上下文 & 费用构建
// ---------------------------------------------------------------------------

const VALID_ASPECT_RATIOS = new Set(['1:1', '4:3', '16:9', '9:16', '3:2', '2:3'])
const VALID_RESOLUTIONS = new Set(['1k', '2k', '4k'])
const CUSTOM_RESOLUTION_RE = /^\d{3,5}x\d{3,5}$/

function buildRequestContextAndCost(
  args: Record<string, unknown>,
  config: Config,
): { requestContext: ImageRequestContext; generationCost: ReturnType<typeof calculateGenerationCost> } {
  let numImages = config.defaultNumImages || 1
  if (typeof args.numImages === 'number' && Number.isFinite(args.numImages)) {
    numImages = Math.max(1, Math.min(4, Math.round(args.numImages)))
  }

  const requestContext: ImageRequestContext = { numImages }

  if (typeof args.aspectRatio === 'string' && VALID_ASPECT_RATIOS.has(args.aspectRatio)) {
    requestContext.aspectRatio = args.aspectRatio as ImageRequestContext['aspectRatio']
  }

  if (typeof args.resolution === 'string') {
    const res = args.resolution.trim()
    if (VALID_RESOLUTIONS.has(res) || CUSTOM_RESOLUTION_RE.test(res)) {
      requestContext.resolution = res as ImageRequestContext['resolution']
    }
  }

  const modelSuffix = typeof args.modelSuffix === 'string' ? args.modelSuffix.trim() : ''
  let modelMapping: ModelMappingConfig | undefined
  if (modelSuffix) {
    modelMapping = (config.modelMappings || []).find((item) => item.suffix === modelSuffix)
  } else {
    modelMapping = (config.modelMappings || [])[0]
  }

  if (modelMapping) {
    requestContext.supplier = modelMapping.supplier
    requestContext.provider = modelMapping.protocol
    if (modelMapping.modelId) {
      requestContext.modelId = modelMapping.modelId
    }
  }

  const generationCost = calculateGenerationCost({
    numImages,
    modelMapping,
    config,
  })

  return { requestContext, generationCost }
}

// ---------------------------------------------------------------------------
// 风格预设解析
// ---------------------------------------------------------------------------

function resolveRequestedStylePreset(
  args: Record<string, unknown>,
  aiGenerator: AiImageGeneratorService,
):
  | { preset: ResolvedStyleConfig; matches: StyleMatchCandidate[] }
  | { error: string } {
  const explicitStylePreset =
    typeof args.stylePreset === 'string' ? args.stylePreset.trim() : ''
  if (explicitStylePreset) {
    const preset = aiGenerator.getStylePreset(explicitStylePreset)
    if (!preset) {
      return { error: `未找到风格预设: ${explicitStylePreset}` }
    }
    return {
      preset,
      matches: [{ style: preset, score: 999, matchedTerms: [explicitStylePreset] }],
    }
  }

  const styleQuery = typeof args.styleQuery === 'string' ? args.styleQuery.trim() : ''
  if (!styleQuery) {
    return { error: 'stylePreset 或 styleQuery 至少需要提供一个。' }
  }

  const matches = aiGenerator.matchStylePresets(styleQuery, 3)
  if (!matches.length) {
    return { error: `未找到与「${styleQuery}」匹配的风格预设。` }
  }
  const topMatch = matches[0]
  if (!topMatch) {
    return { error: `未找到与「${styleQuery}」匹配的风格预设。` }
  }

  return { preset: topMatch.style, matches }
}

// ---------------------------------------------------------------------------
// 图片引用解析
// ---------------------------------------------------------------------------

function resolveReferenceImages(
  referenceMode: string,
  args: Record<string, unknown>,
  session: ToolSessionLike,
  aiGenerator: AiImageGeneratorService,
): string[] {
  if (referenceMode === 'explicit') {
    return normalizeImageUrls(
      Array.isArray(args.imageUrls)
        ? args.imageUrls.filter(
            (item): item is string => typeof item === 'string' && item.trim().length > 0,
          )
        : [],
    )
  }

  if (referenceMode === 'last_generated') {
    const conversationId = aiGenerator.buildSessionConversationId(session as any)
    if (!conversationId) return []
    const lastGenerated = aiGenerator.getConversationImageContext(conversationId)?.lastGenerated
    return lastGenerated ? [lastGenerated.imageUrl] : []
  }

  if (referenceMode === 'current_message') {
    return parseImagesFromMessageContent(session.content)
  }

  return []
}

function parseImagesFromMessageContent(content: unknown): string[] {
  if (typeof content === 'string' && content.trim()) {
    return normalizeImageUrls(
      h.select(h.parse(content), 'img').map((img: any) => img.attrs?.src),
    )
  }

  if (Array.isArray(content)) {
    return normalizeImageUrls(
      h.select(content as any[], 'img').map((img: any) => img.attrs?.src),
    )
  }

  return []
}

function summarizeImageUrl(url: string): string {
  if (url.startsWith('data:')) {
    return '[base64_image]'
  }
  return url
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function expectString(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} is required.`)
  }
  return value.trim()
}

function normalizeImageUrls(items: unknown[]): string[] {
  return items
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
}

async function withImageTaskLock(
  session: ToolSessionLike,
  aiGenerator: AiImageGeneratorService,
  work: (requestId: string) => Promise<ToolExecuteResult>,
): Promise<ToolExecuteResult> {
  const requestId = aiGenerator.userManager.startTask(session.userId)
  if (!requestId) {
    return Failed('您有一个图像处理任务正在进行中，请等待完成。')
  }

  try {
    return await work(requestId)
  } catch (error) {
    try { await aiGenerator.releaseReservation(requestId, error instanceof Error ? error.message : String(error)) } catch { /* reservation may not exist */ }
    throw error
  } finally {
    aiGenerator.userManager.endTask(session.userId, requestId)
  }
}
