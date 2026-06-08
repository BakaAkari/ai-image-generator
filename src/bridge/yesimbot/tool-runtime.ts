/**
 * YesImBot 工具运行时（AI SDK 格式）。
 *
 * 将 YESIMBOT_TOOL_DEFINITIONS 中定义的工具转换为 AI SDK ToolDefinition，
 * 提供 execute() 函数实现。关键适配点（vs ChatLuna Bridge）：
 *
 * 1. 返回 AI SDK ToolResultPart[] 而非 string
 * 2. execute(args, context) 签名，context 包含 messages、abortSignal、experimental_context
 * 3. Schema 通过 jsonSchema() 包装 Zod schema
 * 4. Session 信息从 ExtensionContextLike 提取
 * 5. 配额预检、用量记录逻辑与 ChatLuna 版本共用
 */

import { h } from 'koishi'

import { calculateGenerationCost, scaleGenerationCost } from '../../shared/billing.js'
import type { Config } from '../../shared/config.js'
import type {
  ImageRequestContext,
  ModelMappingConfig,
  ResolvedStyleConfig,
  StyleMatchCandidate,
} from '../../shared/types.js'
import type { AiImageGeneratorService } from '../../service/AiImageGeneratorService.js'
import type {
  ExtensionContextLike,
  ToolDefinitionLike,
  ToolExecutionContextLike,
} from './runtime.js'
import type { YesImBotToolDefinition } from './tool-definitions.js'
import type { YesImBotSessionLike } from './types.js'

// ---------------------------------------------------------------------------
// 工具实例工厂
// ---------------------------------------------------------------------------

export function createYesImBotToolInstance(
  definition: YesImBotToolDefinition,
  aiGenerator: AiImageGeneratorService,
  config: Config,
  jsonSchema: (schema: unknown) => unknown,
  logger: (...args: any[]) => void,
): ToolDefinitionLike {
  // 需要 zod 来构建 schema — 通过 require 动态加载
  let zod: any
  try {
    zod = require('zod')
  } catch {
    try {
      zod = ((globalThis as any).__zod__)
    } catch {
      throw new Error('zod is required for YesImBot bridge but could not be loaded.')
    }
  }

  // 先检查 zod 是否可用
  if (!zod) {
    throw new Error('zod is required for YesImBot bridge but could not be loaded.')
  }

  const zodSchema = definition.inputSchemaBuilder(zod)
  const aiSdkSchema = jsonSchema(zodSchema)

  return {
    name: definition.name,
    description: definition.description,
    inputSchema: aiSdkSchema,
    promptSnippet: definition.promptSnippet,
    promptGuidelines: definition.promptGuidelines,
    execute: async (params: unknown, context: ToolExecutionContextLike) => {
      const extensionCtx = context.experimental_context
      const session = extractSessionFromContext(extensionCtx)

      try {
        switch (definition.name) {
          case 'aigc_generate_image':
            return await runGenerateImageTool(params, session, aiGenerator, config, logger)
          case 'aigc_edit_image':
            return await runEditImageTool(params, session, aiGenerator, config, logger)
          case 'aigc_apply_style_preset':
            return await runStylePresetTool(params, session, aiGenerator, config, logger)
          case 'aigc_get_quota':
            return await runGetQuotaTool(session, aiGenerator, logger)
          case 'aigc_list_styles':
            return runListStylesTool(params, aiGenerator)
          default:
            throw new Error(`unsupported tool: ${definition.name}`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger('YesImBot tool execute failed: %s, error: %s', definition.name, message)
        return [{ type: 'text', text: `执行失败: ${message}` }]
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 工具执行函数
// ---------------------------------------------------------------------------

async function runGenerateImageTool(
  params: unknown,
  session: YesImBotSessionLike,
  aiGenerator: AiImageGeneratorService,
  config: Config,
  logger: (...args: any[]) => void,
): Promise<unknown[]> {
  return withImageTaskLock(session, aiGenerator, async () => {
    const input = params as Record<string, unknown>
    const prompt = expectString(input.prompt, 'prompt')
    const { requestContext, generationCost } = buildRequestContextAndCost(input, config)

    const reservation = await aiGenerator.checkAndReserveQuota(
      session.userId,
      session.username || session.userId,
      generationCost,
      session.platform || undefined,
    )
    if (!reservation.allowed) {
      return [{ type: 'text', text: reservation.message || '积分不足。' }]
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

    const actualCost =
      images.length > 0 ? scaleGenerationCost(generationCost, images.length) : generationCost
    const usage = await aiGenerator.recordUsage(
      session.userId,
      session.username || session.userId,
      'aigc_generate_image',
      actualCost,
      session.platform || undefined,
    )

    return buildToolResult([
      `生成完成！共生成 ${images.length} 张图像。`,
      ...(usage?.summary
        ? [`剩余积分: ${aiGenerator.formatCredits(usage.summary.totalAvailable)}`]
        : []),
    ], images)
  })
}

async function runEditImageTool(
  params: unknown,
  session: YesImBotSessionLike,
  aiGenerator: AiImageGeneratorService,
  config: Config,
  logger: (...args: any[]) => void,
): Promise<unknown[]> {
  return withImageTaskLock(session, aiGenerator, async () => {
    const input = params as Record<string, unknown>
    const prompt = expectString(input.prompt, 'prompt')
    const referenceMode =
      typeof input.referenceMode === 'string' ? input.referenceMode : 'explicit'
    const conversationId = aiGenerator.buildSessionConversationId(session as any)
    const imageUrls = resolveReferenceImages(
      referenceMode,
      input,
      session,
      aiGenerator,
    )
    if (!imageUrls.length) {
      return [{ type: 'text', text: '未能解析到参考图片。请提供图片 URL 或在消息中附带图片。' }]
    }

    const { requestContext, generationCost } = buildRequestContextAndCost(input, config)

    const reservation = await aiGenerator.checkAndReserveQuota(
      session.userId,
      session.username || session.userId,
      generationCost,
      session.platform || undefined,
    )
    if (!reservation.allowed) {
      return [{ type: 'text', text: reservation.message || '积分不足。' }]
    }

    const images = await aiGenerator.requestProviderImages(
      prompt,
      imageUrls,
      generationCost.numImages,
      requestContext,
    )

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

    const actualCost =
      images.length > 0 ? scaleGenerationCost(generationCost, images.length) : generationCost
    const usage = await aiGenerator.recordUsage(
      session.userId,
      session.username || session.userId,
      'aigc_edit_image',
      actualCost,
      session.platform || undefined,
    )

    return buildToolResult([
      `编辑完成！共生成 ${images.length} 张图像。`,
      ...(usage?.summary
        ? [`剩余积分: ${aiGenerator.formatCredits(usage.summary.totalAvailable)}`]
        : []),
    ], images)
  })
}

async function runStylePresetTool(
  params: unknown,
  session: YesImBotSessionLike,
  aiGenerator: AiImageGeneratorService,
  config: Config,
  logger: (...args: any[]) => void,
): Promise<unknown[]> {
  return withImageTaskLock(session, aiGenerator, async () => {
    const input = params as Record<string, unknown>
    const resolvedStyle = resolveRequestedStylePreset(input, aiGenerator)
    if ('error' in resolvedStyle) {
      return [{ type: 'text', text: resolvedStyle.error }]
    }
    const { preset } = resolvedStyle

    const promptAdditions =
      typeof input.promptAdditions === 'string' ? input.promptAdditions.trim() : ''
    const prompt = [preset.prompt, promptAdditions].filter(Boolean).join(' - ')
    const referenceMode =
      typeof input.referenceMode === 'string' ? input.referenceMode : 'none'
    const imageUrls =
      referenceMode === 'none'
        ? []
        : resolveReferenceImages(referenceMode, input, session, aiGenerator)

    if (referenceMode !== 'none' && !imageUrls.length) {
      return [{ type: 'text', text: '未能解析到参考图片。' }]
    }

    const { requestContext, generationCost } = buildRequestContextAndCost(input, config)

    const reservation = await aiGenerator.checkAndReserveQuota(
      session.userId,
      session.username || session.userId,
      generationCost,
      session.platform || undefined,
    )
    if (!reservation.allowed) {
      return [{ type: 'text', text: reservation.message || '积分不足。' }]
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

    const actualCost =
      images.length > 0 ? scaleGenerationCost(generationCost, images.length) : generationCost
    const usage = await aiGenerator.recordUsage(
      session.userId,
      session.username || session.userId,
      preset.commandName,
      actualCost,
      session.platform || undefined,
    )

    return buildToolResult([
      `已应用「${preset.commandName}」风格，生成 ${images.length} 张图像。`,
      ...(usage?.summary
        ? [`剩余积分: ${aiGenerator.formatCredits(usage.summary.totalAvailable)}`]
        : []),
    ], images)
  })
}

async function runGetQuotaTool(
  session: YesImBotSessionLike,
  aiGenerator: AiImageGeneratorService,
  logger: (...args: any[]) => void,
): Promise<unknown[]> {
  const summary = await aiGenerator.getQuotaSummary(
    session.userId,
    session.username || session.userId,
  )
  return [
    {
      type: 'text',
      text: [
        `用户: ${summary.userName || session.userId}`,
        `每日免费剩余: ${aiGenerator.formatCredits(summary.dailyFreeRemaining)}`,
        `已购积分: ${aiGenerator.formatCredits(summary.purchasedCredits)}`,
        `总可用积分: ${aiGenerator.formatCredits(summary.totalAvailable)}`,
        `已生成图像: ${summary.totalImagesGenerated} 张`,
        `累计消耗: ${aiGenerator.formatCredits(summary.totalConsumedCredits)}`,
        `累计充值: ${aiGenerator.formatCredits(summary.totalGrantedCredits)}`,
      ].join('\n'),
    },
  ]
}

function runListStylesTool(
  params: unknown,
  aiGenerator: AiImageGeneratorService,
): unknown[] {
  const input = params as Record<string, unknown>
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  const allStyles = aiGenerator.listStylePresets()

  let styles = allStyles
  if (query) {
    const matches = aiGenerator.matchStylePresets(query, 20)
    styles = matches.map((m) => m.style)
  }

  if (!styles.length) {
    return [{ type: 'text', text: query ? `未找到匹配「${query}」的风格预设。` : '暂无可用风格预设。' }]
  }

  const lines = styles.map(
    (s) =>
      `- **${s.commandName}**${s.description ? `: ${s.description}` : ''}${s.category ? ` [${s.category}]` : ''}`,
  )

  return [
    {
      type: 'text',
      text: [
        query ? `匹配「${query}」的风格预设 (${lines.length} 个):` : `可用风格预设 (${lines.length} 个):`,
        '',
        ...lines,
        '',
        '使用 aigc_apply_style_preset 工具并传入 stylePreset 参数来应用风格。',
      ].join('\n'),
    },
  ]
}

// ---------------------------------------------------------------------------
// 请求上下文 & 费用构建（与 ChatLuna 共用逻辑）
// ---------------------------------------------------------------------------

const VALID_ASPECT_RATIOS = new Set(['1:1', '4:3', '16:9', '9:16', '3:2', '2:3'])
const VALID_RESOLUTIONS = new Set(['1k', '2k', '4k'])
const CUSTOM_RESOLUTION_RE = /^\d{3,5}x\d{3,5}$/

function buildRequestContextAndCost(
  input: Record<string, unknown>,
  config: Config,
): { requestContext: ImageRequestContext; generationCost: ReturnType<typeof calculateGenerationCost> } {
  let numImages = config.defaultNumImages || 1
  if (typeof input.numImages === 'number' && Number.isFinite(input.numImages)) {
    numImages = Math.max(1, Math.min(4, Math.round(input.numImages)))
  }

  const requestContext: ImageRequestContext = { numImages }

  if (typeof input.aspectRatio === 'string' && VALID_ASPECT_RATIOS.has(input.aspectRatio)) {
    requestContext.aspectRatio = input.aspectRatio as ImageRequestContext['aspectRatio']
  }

  if (typeof input.resolution === 'string') {
    const res = input.resolution.trim()
    if (VALID_RESOLUTIONS.has(res) || CUSTOM_RESOLUTION_RE.test(res)) {
      requestContext.resolution = res as ImageRequestContext['resolution']
    }
  }

  const modelSuffix = typeof input.modelSuffix === 'string' ? input.modelSuffix.trim() : ''
  let modelMapping: ModelMappingConfig | undefined
  if (modelSuffix) {
    modelMapping = (config.modelMappings || []).find((item) => item.suffix === modelSuffix)
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
  input: Record<string, unknown>,
  aiGenerator: AiImageGeneratorService,
):
  | { preset: ResolvedStyleConfig; matches: StyleMatchCandidate[] }
  | { error: string } {
  const explicitStylePreset =
    typeof input.stylePreset === 'string' ? input.stylePreset.trim() : ''
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

  const styleQuery = typeof input.styleQuery === 'string' ? input.styleQuery.trim() : ''
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
  input: Record<string, unknown>,
  session: YesImBotSessionLike,
  aiGenerator: AiImageGeneratorService,
): string[] {
  if (referenceMode === 'explicit') {
    return normalizeImageUrls(
      Array.isArray(input.imageUrls)
        ? input.imageUrls.filter(
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

// ---------------------------------------------------------------------------
// Session 信息提取
// ---------------------------------------------------------------------------

function extractSessionFromContext(ctx: ExtensionContextLike): YesImBotSessionLike {
  // 从 ExtensionContext 提取 session 信息
  // YesImBot 的 ExtensionContext 包含 sessionManager
  let userId = 'unknown'
  let channelId = 'unknown'
  let platform = 'yesimbot'
  let isDirect = false
  let username: string | undefined
  let guildId: string | undefined
  let content = ''
  let timestamp = Date.now()

  try {
    const sessionManager = ctx.sessionManager as Record<string, unknown> | undefined
    if (sessionManager) {
      // 尝试从 sessionManager 获取 session 信息
      const currentSession = (sessionManager as any).currentSession || (sessionManager as any).session
      if (currentSession) {
        userId = (currentSession.userId as string) || userId
        channelId = (currentSession.channelId as string) || channelId
        platform = (currentSession.platform as string) || platform
        isDirect = (currentSession.isDirect as boolean) || false
        username = currentSession.username as string | undefined
        guildId = currentSession.guildId as string | undefined
        content = (currentSession.content as string) || ''
        timestamp = (currentSession.timestamp as number) || Date.now()
      }
    }
  } catch {
    // 防御性处理: 如果 sessionManager 结构不同，使用默认值
  }

  return { userId, username, channelId, guildId, platform, isDirect, content, timestamp }
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function buildToolResult(texts: string[], images: string[]): unknown[] {
  const result: unknown[] = [{ type: 'text', text: texts.join('\n') }]
  for (const imageUrl of images) {
    result.push({ type: 'image', image: imageUrl })
  }
  return result
}

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
  session: YesImBotSessionLike,
  aiGenerator: AiImageGeneratorService,
  work: () => Promise<unknown[]>,
): Promise<unknown[]> {
  const requestId = aiGenerator.userManager.startTask(session.userId)
  if (!requestId) {
    return [{ type: 'text', text: '您有一个图像处理任务正在进行中，请等待完成。' }]
  }

  try {
    return await work()
  } finally {
    aiGenerator.userManager.endTask(session.userId, requestId)
  }
}
