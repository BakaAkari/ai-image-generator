/**
 * ChatLuna 工具运行时（V2 积分制适配版）。
 *
 * 关键适配点（vs V1）：
 * - 生成前执行真实积分预授权，结束后按实际交付 settle 或失败 release
 * - 模型路由从 provider/apiFormat 改为 supplier/protocol
 * - 配额消息术语从「次数」改为「积分」
 */

import { h } from 'koishi'

import { calculateGenerationCost } from '../../shared/billing.js'
import { AI_GENERATOR_TOOL_DEFINITIONS } from '../../shared/chatluna-tool-definitions.js'
import type { Config } from '../../shared/config.js'
import type {
  ImageRequestContext,
  ModelMappingConfig,
  ResolvedStyleConfig,
  StyleMatchCandidate,
} from '../../shared/types.js'
import { applyPromptAppends, buildProtocolRequestContext, ContractRejectedParamsError } from '../../shared/generation-setup.js'
import type { AiImageGeneratorService } from '../../service/AiImageGeneratorService.js'
import type { StructuredToolConstructor } from './runtime.js'
import type { ChatLunaConfigAccessor, ChatLunaSessionLike } from './types.js'

// ---------------------------------------------------------------------------
// 基础工具实例工厂
// ---------------------------------------------------------------------------

export function createChatLunaToolInstance(
  StructuredTool: StructuredToolConstructor,
  definition: (typeof AI_GENERATOR_TOOL_DEFINITIONS)[number],
  aiGenerator: AiImageGeneratorService,
  getConfig: ChatLunaConfigAccessor,
) {
  return new (class extends StructuredTool {
    name = definition.name
    description = [
      definition.description,
      `Usage: ${definition.usage}`,
      `Risk: ${definition.riskLevel}`,
      `Input JSON schema: ${JSON.stringify(definition.inputSchema)}`,
    ].join('\n')
    schema = definition.inputSchema

    constructor() {
      super({ verboseParsingErrors: true })
    }

    async _call(
      input: Record<string, unknown>,
      _runManager?: unknown,
      runtimeConfig?: { configurable?: { session?: ChatLunaSessionLike } },
    ) {
      const session = runtimeConfig?.configurable?.session
      if (!session?.userId) {
        return formatToolError('会话无效，无法识别用户。')
      }

      try {
        switch (definition.name) {
          case 'aigc_generate_image':
            return await runGenerateImageTool(input, session, aiGenerator, getConfig)
          case 'aigc_edit_image':
            return await runEditImageTool(input, session, aiGenerator, getConfig)
          case 'aigc_apply_style_preset':
            return await runStylePresetTool(input, session, aiGenerator, getConfig)
          case 'aigc_get_quota':
            return await runGetQuotaTool(session, aiGenerator)
          case 'aigc_list_styles':
            return formatToolJson({
              items: aiGenerator.listStylePresets().map((style) => ({
                commandName: style.commandName,
                description: style.description || '',
                groupName: style.groupName || '',
                aliases: style.aliases || [],
                keywords: style.keywords || [],
                examples: style.examples || [],
                category: style.category || '',
                whenToUse: style.whenToUse || '',
              })),
            })
          default:
            return formatToolError(`unsupported tool: ${definition.name}`)
        }
      } catch (error) {
        return formatToolError(error instanceof Error ? error.message : String(error))
      }
    }
  })()
}

// ---------------------------------------------------------------------------
// 工具执行函数
// ---------------------------------------------------------------------------

async function runGenerateImageTool(
  input: Record<string, unknown>,
  session: ChatLunaSessionLike,
  aiGenerator: AiImageGeneratorService,
  getConfig: ChatLunaConfigAccessor,
) {
  const config = getConfig()
  const rateLimit = aiGenerator.userManager.checkRateLimit(session.userId!, config)
  if (!rateLimit.allowed) {
    return formatToolError(rateLimit.message || '操作过于频繁，请稍后再试。')
  }
  const freePlatform = aiGenerator.isFreePlatform(session.platform || null)
  return withImageTaskLock(session, aiGenerator, async (requestId) => {
    const prompt = expectString(input.prompt, 'prompt')
    const { requestContext, generationCost } = buildRequestContextAndCost(input, config, aiGenerator, prompt, 'text-to-image')
    const providerPrompt = applyPromptAppends(prompt, requestContext.promptAppends)

    if (!freePlatform) {
      const reservation = await aiGenerator.reserveCredits(session.userId!, session.username || session.userId!, requestId, generationCost, session.platform || undefined)
      if (!reservation.allowed) {
        return formatToolError(reservation.message || '积分不足。')
      }
    }

    const { images } = await aiGenerator.requestProviderImages(
      providerPrompt,
      [],
      generationCost.numImages,
      requestContext,
    )
    await sendGeneratedImages(session, images)
    aiGenerator.rememberGeneratedImages({
      session: session as any,
      imageUrls: images,
      prompt,
      requestContext,
      stylePreset: 'aigc_generate_image',
    })

    if (freePlatform) {
      await aiGenerator.recordUsageOnly(session.userId!, session.username || session.userId!, 'aigc_generate_image', images.length)
      return formatToolJson({
        ok: true,
        imagesCount: images.length,
        images: images.map(summarizeImageUrl),
        freePlatform: true,
      })
    }

    await aiGenerator.settleReservation(requestId, images.length, 'aigc_generate_image', { routeId: requestContext.routeId ?? null, modelId: requestContext.modelId ?? null })

    return formatToolJson({
      ok: true,
      imagesCount: images.length,
      images: images.map(summarizeImageUrl),
      creditSummary: await formatQuotaSummary(aiGenerator, session.userId!, session.username || session.userId!),
    })
  })
}

async function runEditImageTool(
  input: Record<string, unknown>,
  session: ChatLunaSessionLike,
  aiGenerator: AiImageGeneratorService,
  getConfig: ChatLunaConfigAccessor,
) {
  const config = getConfig()
  const rateLimit = aiGenerator.userManager.checkRateLimit(session.userId!, config)
  if (!rateLimit.allowed) {
    return formatToolError(rateLimit.message || '操作过于频繁，请稍后再试。')
  }
  const freePlatform = aiGenerator.isFreePlatform(session.platform || null)
  return withImageTaskLock(session, aiGenerator, async (requestId) => {
    const prompt = expectString(input.prompt, 'prompt')
    const referenceMode = expectString(input.referenceMode, 'referenceMode')
    const conversationId = resolveSessionConversationId(session, aiGenerator)
    const imageUrls = resolveReferenceImages(referenceMode, input, session, aiGenerator)
    if (!imageUrls.length) {
      return formatToolError('未能解析到参考图片。')
    }

    const { requestContext, generationCost } = buildRequestContextAndCost(input, config, aiGenerator, prompt, 'image-edit')
    const providerPrompt = applyPromptAppends(prompt, requestContext.promptAppends)

    if (!freePlatform) {
      const reservation = await aiGenerator.reserveCredits(session.userId!, session.username || session.userId!, requestId, generationCost, session.platform || undefined)
      if (!reservation.allowed) {
        return formatToolError(reservation.message || '积分不足。')
      }
    }

    const { images } = await aiGenerator.requestProviderImages(
      providerPrompt,
      imageUrls,
      generationCost.numImages,
      requestContext,
    )
    await sendGeneratedImages(session, images)
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

    if (freePlatform) {
      await aiGenerator.recordUsageOnly(session.userId!, session.username || session.userId!, 'aigc_edit_image', images.length)
      return formatToolJson({
        ok: true,
        imagesCount: images.length,
        images: images.map(summarizeImageUrl),
        referenceMode,
        freePlatform: true,
      })
    }

    await aiGenerator.settleReservation(requestId, images.length, 'aigc_edit_image', { routeId: requestContext.routeId ?? null, modelId: requestContext.modelId ?? null })

    return formatToolJson({
      ok: true,
      imagesCount: images.length,
      images: images.map(summarizeImageUrl),
      referenceMode,
      creditSummary: await formatQuotaSummary(aiGenerator, session.userId!, session.username || session.userId!),
    })
  })
}

async function runStylePresetTool(
  input: Record<string, unknown>,
  session: ChatLunaSessionLike,
  aiGenerator: AiImageGeneratorService,
  getConfig: ChatLunaConfigAccessor,
) {
  return withImageTaskLock(session, aiGenerator, async (requestId) => {
    const resolvedStyle = resolveRequestedStylePreset(input, aiGenerator)
    if ('error' in resolvedStyle) {
      return formatToolError(resolvedStyle.error)
    }
    const { preset, matches } = resolvedStyle

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
      return formatToolError('未能解析到参考图片。')
    }

    const config = getConfig()
    const styleOperation = referenceMode === 'none' ? 'text-to-image' : 'image-edit'
    const { requestContext, generationCost } = buildRequestContextAndCost(input, config, aiGenerator, prompt, styleOperation)
    const providerPrompt = applyPromptAppends(prompt, requestContext.promptAppends)

    const reservation = await aiGenerator.reserveCredits(session.userId!, session.username || session.userId!, requestId, generationCost, session.platform || undefined)
    if (!reservation.allowed) {
      return formatToolError(reservation.message || '积分不足。')
    }

    const { images } = await aiGenerator.requestProviderImages(
      providerPrompt,
      imageUrls,
      generationCost.numImages,
      requestContext,
    )
    await sendGeneratedImages(session, images)
    aiGenerator.rememberGeneratedImages({
      session: session as any,
      imageUrls: images,
      prompt,
      requestContext,
      stylePreset: preset.commandName,
    })

    const usage = await aiGenerator.settleReservation(requestId, images.length, preset.commandName, { routeId: requestContext.routeId ?? null, modelId: requestContext.modelId ?? null })

    return formatToolJson({
      ok: true,
      stylePreset: preset.commandName,
      imagesCount: images.length,
      images: images.map(summarizeImageUrl),
      creditSummary: await formatQuotaSummary(aiGenerator, session.userId!, session.username || session.userId!),
      styleMatches: matches.map((item) => ({
        commandName: item.style.commandName,
        score: item.score,
        matchedTerms: item.matchedTerms,
      })),
    })
  })
}

async function runGetQuotaTool(
  session: ChatLunaSessionLike,
  aiGenerator: AiImageGeneratorService,
) {
  const userId = session.userId
  if (!userId) return formatToolError('会话无效，无法识别用户。')

  const summary = await aiGenerator.getQuotaSummary(
    userId,
    session.username || session.author?.name || userId,
  )
  return formatToolJson({
    userName: summary.userName || userId,
    dailyFreeRemaining: aiGenerator.formatCredits(summary.trialRemaining),
    purchasedCredits: aiGenerator.formatCredits(summary.purchasedCredits),
    totalAvailable: aiGenerator.formatCredits(summary.totalAvailable),
    totalImagesGenerated: summary.totalImagesGenerated,
    totalConsumedCredits: aiGenerator.formatCredits(summary.totalConsumedCredits),
    totalGrantedCredits: aiGenerator.formatCredits(summary.totalGrantedCredits),
  })
}

// ---------------------------------------------------------------------------
// 风格预设工具实例工厂
// ---------------------------------------------------------------------------

export function createStylePresetToolInstance(
  StructuredTool: StructuredToolConstructor,
  style: ResolvedStyleConfig,
  aiGenerator: AiImageGeneratorService,
  getConfig: ChatLunaConfigAccessor,
) {
  const toolName = `aigc_style_${sanitizeToolName(style.commandName)}`
  const description =
    style.description || `Apply ${style.commandName} style to image generation`
  const metadataLines = [
    style.category ? `Category: ${style.category}` : '',
    style.whenToUse ? `When to use: ${style.whenToUse}` : '',
    style.aliases?.length ? `Aliases: ${style.aliases.join(', ')}` : '',
    style.keywords?.length ? `Keywords: ${style.keywords.join(', ')}` : '',
    style.examples?.length ? `Examples: ${style.examples.join(' | ')}` : '',
  ].filter(Boolean)

  return new (class extends StructuredTool {
    name = toolName
    description = [
      description,
      ...metadataLines,
      `Usage: Use this when the user wants to apply the "${style.commandName}" style to generate or edit images.`,
      `Risk: low`,
      `Input JSON schema: ${JSON.stringify(stylePresetInputSchema)}`,
    ].join('\n')
    schema = stylePresetInputSchema

    constructor() {
      super({ verboseParsingErrors: true })
    }

    async _call(
      input: Record<string, unknown>,
      _runManager?: unknown,
      runtimeConfig?: { configurable?: { session?: ChatLunaSessionLike } },
    ) {
      const session = runtimeConfig?.configurable?.session
      if (!session?.userId) {
        return formatToolError('会话无效，无法识别用户。')
      }

      try {
        return await runDynamicStyleTool(input, session, style, aiGenerator, getConfig)
      } catch (error) {
        return formatToolError(error instanceof Error ? error.message : String(error))
      }
    }
  })()
}

const stylePresetInputSchema = {
  type: 'object',
  properties: {
    promptAdditions: {
      type: 'string',
      description: 'Optional extra prompt details.',
    },
    referenceMode: {
      type: 'string',
      enum: ['none', 'current_message', 'quoted_message', 'explicit', 'last_generated'],
      description: 'Where to load reference images from.',
    },
    imageUrls: {
      type: 'array',
      items: { type: 'string' },
      description: 'Explicit image URLs when referenceMode is explicit.',
    },
    numImages: { type: 'number', minimum: 1, maximum: 4 },
    aspectRatio: { type: 'string', enum: ['1:1', '4:3', '16:9', '9:16', '3:2', '2:3'] },
    resolution: { type: 'string', enum: ['1k', '2k', '4k'] },
    modelSuffix: {
      type: 'string',
      description: 'Optional configured model suffix.',
    },
  },
  additionalProperties: false,
} as const

async function runDynamicStyleTool(
  input: Record<string, unknown>,
  session: ChatLunaSessionLike,
  style: ResolvedStyleConfig,
  aiGenerator: AiImageGeneratorService,
  getConfig: ChatLunaConfigAccessor,
) {
  return withImageTaskLock(session, aiGenerator, async (requestId) => {
    const promptAdditions =
      typeof input.promptAdditions === 'string' ? input.promptAdditions.trim() : ''
    const prompt = [style.prompt, promptAdditions].filter(Boolean).join(' - ')
    const referenceMode =
      typeof input.referenceMode === 'string' ? input.referenceMode : 'none'
    const imageUrls =
      referenceMode === 'none'
        ? []
        : resolveReferenceImages(referenceMode, input, session, aiGenerator)

    if (referenceMode !== 'none' && !imageUrls.length) {
      return formatToolError('未能解析到参考图片。')
    }

    const config = getConfig()
    const styleOperation = referenceMode === 'none' ? 'text-to-image' : 'image-edit'
    const { requestContext, generationCost } = buildRequestContextAndCost(input, config, aiGenerator, prompt, styleOperation)
    const providerPrompt = applyPromptAppends(prompt, requestContext.promptAppends)

    const reservation = await aiGenerator.reserveCredits(session.userId!, session.username || session.userId!, requestId, generationCost, session.platform || undefined)
    if (!reservation.allowed) {
      return formatToolError(reservation.message || '积分不足。')
    }

    const { images } = await aiGenerator.requestProviderImages(
      providerPrompt,
      imageUrls,
      generationCost.numImages,
      requestContext,
    )
    await sendGeneratedImages(session, images)
    aiGenerator.rememberGeneratedImages({
      session: session as any,
      imageUrls: images,
      prompt,
      requestContext,
      stylePreset: style.commandName,
    })

    const usage = await aiGenerator.settleReservation(requestId, images.length, style.commandName, { routeId: requestContext.routeId ?? null, modelId: requestContext.modelId ?? null })

    return formatToolJson({
      ok: true,
      stylePreset: style.commandName,
      imagesCount: images.length,
      images: images.map(summarizeImageUrl),
      creditSummary: await formatQuotaSummary(aiGenerator, session.userId!, session.username || session.userId!),
    })
  })
}

// ---------------------------------------------------------------------------
// 请求上下文 & 费用构建（V2 适配）
//
// 通过 shared/generation-setup.buildProtocolRequestContext 统一完成
// “协议参数规范化 + 缺失值自动补全”，与命令入口、向导、YesImBot bridge 共享同一实现。
// ---------------------------------------------------------------------------

function buildRequestContextAndCost(
  input: Record<string, unknown>,
  config: Config,
  aiGenerator: AiImageGeneratorService,
  prompt?: string,
  operation: 'text-to-image' | 'image-edit' | 'compose-image' = 'text-to-image',
): { requestContext: ImageRequestContext; generationCost: ReturnType<typeof calculateGenerationCost> } {
  let numImages = config.defaultNumImages || 1
  if (typeof input.numImages === 'number' && Number.isFinite(input.numImages)) {
    numImages = Math.max(1, Math.min(4, Math.round(input.numImages)))
  }

  const modelSuffix = typeof input.modelSuffix === 'string' ? input.modelSuffix.trim() : ''
  const modelMapping: ModelMappingConfig | undefined = modelSuffix
    ? (config.modelMappings || []).find((item) => item.suffix === modelSuffix)
    : (config.modelMappings || [])[0]

  const protocol = modelMapping ? aiGenerator.getProtocolForModelId(modelMapping.modelId, operation) : undefined
  const contract = modelMapping ? aiGenerator.resolveContractForMapping(modelMapping, operation) : undefined

  const { requestContext, rejectedParams } = buildProtocolRequestContext({
    protocol,
    ...(modelMapping?.supplier !== undefined ? { supplier: modelMapping.supplier } : {}),
    ...(modelMapping !== undefined ? { modelMapping } : {}),
    operation,
    ...(contract ? { contractId: contract.id } : {}),
    explicit: {
      resolution: typeof input.resolution === 'string' ? input.resolution : undefined,
      aspectRatio: typeof input.aspectRatio === 'string' ? input.aspectRatio : undefined,
      imageSize: typeof input.imageSize === 'string' ? input.imageSize : undefined,
      ar: typeof input.ar === 'string' ? input.ar : undefined,
      stylize: typeof input.stylize === 'number' || typeof input.stylize === 'string'
        ? (input.stylize as number | string)
        : undefined,
      numImages,
    },
    defaultNumImages: numImages,
    ...(prompt !== undefined ? { existingPrompt: prompt } : {}),
  })

  // fail-closed：契约拒绝任何显式参数时立刻抛错，避免预授权先扣积分后失败
  if (rejectedParams && rejectedParams.length > 0) {
    throw new ContractRejectedParamsError(rejectedParams)
  }

  requestContext.numImages = numImages

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
      return { error: `未找到风格预设：${explicitStylePreset}` }
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
  session: ChatLunaSessionLike,
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
    const conversationId = resolveSessionConversationId(session, aiGenerator)
    if (!conversationId) return []
    const lastGenerated = aiGenerator.getConversationImageContext(conversationId)
      ?.lastGenerated
    return lastGenerated ? [lastGenerated.imageUrl] : []
  }

  if (referenceMode === 'current_message') {
    return parseImagesFromMessageContent(session.content)
  }

  if (referenceMode === 'quoted_message') {
    return normalizeImageUrls([
      ...parseImagesFromMessageContent(session.quote?.content),
      ...(Array.isArray(session.quote?.elements)
        ? h
            .select(session.quote.elements as any[], 'img')
            .map((img: any) => img.attrs?.src)
        : []),
    ])
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
// 工具函数
// ---------------------------------------------------------------------------

async function sendGeneratedImages(session: ChatLunaSessionLike, images: string[]): Promise<string[]> {
  if (typeof session.send !== 'function') return []
  const sent: string[] = []
  for (const imageUrl of images) {
    try {
      await Promise.resolve(session.send(h.image(imageUrl)))
      sent.push(imageUrl)
    } catch (err) {
      // 单张发送失败不影响后续图片
      continue
    }
  }
  return sent
}

function expectString(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} is required.`)
  }
  return value.trim()
}

function formatToolError(message: string): string {
  return formatToolJson({ ok: false, error: message })
}

function formatToolJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function summarizeImageUrl(url: string): string {
  if (url.startsWith('data:')) {
    return '[base64_image]'
  }
  return url
}

function normalizeImageUrls(items: unknown[]): string[] {
  return items
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
}

function resolveSessionConversationId(
  session: ChatLunaSessionLike,
  aiGenerator: AiImageGeneratorService,
): string | undefined {
  return aiGenerator.buildSessionConversationId(session as any)
}

async function formatQuotaSummary(aiGenerator: AiImageGeneratorService, userId: string, userName: string) {
  const summary = await aiGenerator.getQuotaSummary(userId, userName)
  return {
    totalAvailable: aiGenerator.formatCredits(summary.totalAvailable),
    dailyFreeRemaining: aiGenerator.formatCredits(summary.trialRemaining),
    purchasedCredits: aiGenerator.formatCredits(summary.purchasedCredits),
  }
}

async function withImageTaskLock(
  session: ChatLunaSessionLike,
  aiGenerator: AiImageGeneratorService,
  work: (requestId: string) => Promise<string>,
): Promise<string> {
  const userId = session.userId
  if (!userId) {
    return formatToolError('会话无效，无法识别用户。')
  }

  const requestId = aiGenerator.userManager.startTask(userId)
  if (!requestId) {
    return formatToolError('您有一个图像处理任务正在进行中，请等待完成。')
  }

  try {
    return await work(requestId)
  } catch (error) {
    try { await aiGenerator.releaseReservation(requestId, error instanceof Error ? error.message : String(error)) } catch { /* reservation may not exist */ }
    throw error
  } finally {
    aiGenerator.userManager.endTask(userId, requestId)
  }
}

function sanitizeToolName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_\u4e00-\u9fff]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '')
}
