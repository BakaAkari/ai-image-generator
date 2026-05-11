/**
 * AiImageGeneratorService —— V2 服务层。
 *
 * 供应商语义 + 协议路由版本：配置页只暴露 OpenAI 兼容 / OpenAI 官方 / Gemini 官方。
 * 运行时仍复用 openai-images / openai-chat / gemini 三类 Provider。
 */

import type { Context, Session } from 'koishi'
import { Service } from 'koishi'

import type { Config } from '../shared/config.js'
import type {
  GeneratedImageRecord,
  GenerationDisplayInfo,
  ImageGenerationModifiers,
  ImageRequestContext,
  ProviderType,
  ResolvedStyleConfig,
  StyleConfig,
  StyleMatchCandidate,
} from '../shared/types.js'
import { PLUGIN_NAME } from '../shared/constants.js'
import { ImageContextStore } from '../core/image-context-store.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { ImageProvider as RuntimeImageProvider } from '../providers/types.js'
import { UserManager } from '../services/UserManager.js'

declare module 'koishi' {
  interface Context {
    aiImageGenerator: AiImageGeneratorService
  }
}

export interface RememberGeneratedImagesParams {
  session?: Session | null
  conversationId?: string
  imageUrls: string[]
  prompt: string
  source?: GeneratedImageRecord['source']
  requestContext?: ImageRequestContext
  stylePreset?: string
  parentRecordId?: string
}

export interface UsageRecordingResult {
  totalUsageCount: number
  remainingPurchasedCount: number
  remainingToday?: number
  isAdmin: boolean
  isPlatformExempt: boolean
}

interface SessionConversationLike {
  conversationId?: string
  conversation_id?: string
  roomId?: string
  room_id?: string
  platform?: string
  channelId?: string
  guildId?: string
  userId?: string
}

const DEFAULT_GEMINI_API_BASE = 'https://generativelanguage.googleapis.com'
const DEFAULT_OPENAI_API_BASE = 'https://api.openai.com/v1'
const DEFAULT_OPENAI_IMAGES_MODEL_ID = 'gpt-image-2'
const DEFAULT_OPENAI_CHAT_MODEL_ID = 'gemini-2.5-flash-image'
const DEFAULT_CONTEXT_HISTORY_SIZE = 20

export class AiImageGeneratorService extends Service {
  readonly userManager: UserManager
  readonly imageContextStore: ImageContextStore

  private pluginConfig: Config
  private readonly pluginLogger: ReturnType<Context['logger']>
  private readonly providerRegistry: ProviderRegistry
  private styleDefinitions: ResolvedStyleConfig[]

  constructor(
    ctx: Context,
    config: Config,
    userManager: UserManager,
    providerRegistry: ProviderRegistry,
  ) {
    super(ctx, 'aiImageGenerator', true)

    this.pluginConfig = config
    this.userManager = userManager
    this.providerRegistry = providerRegistry
    this.imageContextStore = new ImageContextStore()
    this.pluginLogger = ctx.logger(PLUGIN_NAME)
    this.styleDefinitions = this.collectStyleDefinitions(config)
  }

  // ---------------------------------------------------------------------------
  // 配置 & 风格
  // ---------------------------------------------------------------------------

  updateConfig(config: Config) {
    this.pluginConfig = config
    this.styleDefinitions = this.collectStyleDefinitions(config)
  }

  getConfig(): Config {
    return this.pluginConfig
  }

  // ---------------------------------------------------------------------------
  // Provider 实例化
  // ---------------------------------------------------------------------------

  getProviderInstance(requestContext?: ImageRequestContext): RuntimeImageProvider {
    const provider = this.resolveProvider(requestContext)
    const factoryConfig = this.buildProviderFactoryConfig(provider, requestContext)
    return this.providerRegistry.createProvider(provider, this.ctx, factoryConfig)
  }

  async requestProviderImages(
    prompt: string,
    imageUrls: string | string[],
    numImages: number,
    requestContext?: ImageRequestContext,
    onImageGenerated?: (imageUrl: string, index: number, total: number) => void | Promise<void>,
  ): Promise<string[]> {
    const provider = this.resolveProvider(requestContext)
    const targetModelId = requestContext?.modelId
    const imageOptions = {
      resolution: requestContext?.resolution,
      aspectRatio: requestContext?.aspectRatio,
    }

    this.pluginLogger.info('requestProviderImages 调用', {
      provider,
      modelId: targetModelId || 'default',
      numImages,
      hasCallback: !!onImageGenerated,
      promptLength: prompt.length,
      imageUrlsCount: Array.isArray(imageUrls) ? imageUrls.length : (imageUrls ? 1 : 0),
      ...imageOptions,
    })

    const providerInstance = this.getProviderInstance(requestContext)
    const result = await providerInstance.generateImages(
      prompt,
      imageUrls,
      numImages,
      imageOptions,
      onImageGenerated,
    )

    this.pluginLogger.info('requestProviderImages 完成', {
      provider,
      resultCount: result.length,
    })

    return result
  }

  // ---------------------------------------------------------------------------
  // 会话上下文 / 图像记忆
  // ---------------------------------------------------------------------------

  buildSessionConversationId(session?: SessionConversationLike | Session | null): string | undefined {
    if (!session) return undefined

    const explicitConversationId = [
      (session as SessionConversationLike).conversationId,
      (session as SessionConversationLike).conversation_id,
      (session as SessionConversationLike).roomId,
      (session as SessionConversationLike).room_id,
    ].find((value): value is string => typeof value === 'string' && value.trim().length > 0)

    if (explicitConversationId) {
      const platformPrefix = typeof session.platform === 'string' && session.platform.trim()
        ? `${session.platform.trim()}:`
        : ''
      if (platformPrefix && explicitConversationId.startsWith(platformPrefix)) {
        return explicitConversationId.trim()
      }
      return `${platformPrefix}${explicitConversationId.trim()}`
    }

    const base = session.channelId || session.guildId || session.userId
    if (!base) return undefined

    const platformPrefix = typeof session.platform === 'string' && session.platform.trim()
      ? `${session.platform.trim()}:`
      : ''
    return `${platformPrefix}${base}`
  }

  rememberGeneratedImages(params: RememberGeneratedImagesParams): GeneratedImageRecord[] {
    const conversationId = params.conversationId || this.buildSessionConversationId(params.session)
    const userId = params.session?.userId || 'unknown'
    if (!conversationId || !params.imageUrls.length) return []

    const provider = this.resolveProvider(params.requestContext)
    const modelId = params.requestContext?.modelId || this.resolveDefaultModelId(provider)

    const createdAt = Date.now()
    const records: GeneratedImageRecord[] = params.imageUrls.map((imageUrl, index) => {
      const record: GeneratedImageRecord = {
        id: `${conversationId}:${createdAt}:${index}`,
        conversationId,
        userId,
        createdAt,
        source: params.source || 'generated',
        imageUrl,
        prompt: params.prompt,
        normalizedPrompt: params.prompt.trim(),
        provider,
        modelId: modelId || '',
        ...(params.requestContext?.aspectRatio !== undefined
          ? { aspectRatio: params.requestContext.aspectRatio }
          : {}),
        ...(params.requestContext?.resolution !== undefined
          ? { resolution: params.requestContext.resolution }
          : {}),
        ...(params.stylePreset !== undefined ? { stylePreset: params.stylePreset } : {}),
        ...(params.parentRecordId !== undefined ? { parentRecordId: params.parentRecordId } : {}),
      }

      this.imageContextStore.addGeneratedRecord(record, {
        maxRecordsPerConversation: DEFAULT_CONTEXT_HISTORY_SIZE,
      })
      return record
    })

    return records
  }

  getConversationImageContext(conversationId: string) {
    return this.imageContextStore.getConversationContext(conversationId)
  }

  clearConversationImageContext(conversationId: string) {
    this.imageContextStore.clearConversation(conversationId)
  }

  pruneConversationImageContexts(ttlSeconds: number) {
    this.imageContextStore.pruneExpired(ttlSeconds * 1000)
  }

  // ---------------------------------------------------------------------------
  // 风格预设
  // ---------------------------------------------------------------------------

  listStylePresets(): ResolvedStyleConfig[] {
    return this.styleDefinitions
  }

  getStylePreset(commandName: string): ResolvedStyleConfig | undefined {
    const normalized = commandName.trim().toLowerCase()
    return this.styleDefinitions.find((style) => {
      if (style.commandName.trim().toLowerCase() === normalized) return true
      return Array.isArray(style.aliases)
        && style.aliases.some(alias => alias.trim().toLowerCase() === normalized)
    })
  }

  matchStylePresets(query: string, limit = 3): StyleMatchCandidate[] {
    const normalizedQuery = normalizeMatchText(query)
    if (!normalizedQuery) return []

    const queryTerms = buildQueryTerms(query)
    const candidates: StyleMatchCandidate[] = []

    for (const style of this.styleDefinitions) {
      const matchedTerms = new Set<string>()
      let score = 0

      const addMatches = (value: string | undefined, weight: number) => {
        const normalizedValue = normalizeMatchText(value)
        if (!normalizedValue) return

        if (normalizedValue === normalizedQuery) {
          score += weight * 3
          matchedTerms.add(value!.trim())
          return
        }

        if (normalizedValue.includes(normalizedQuery) || normalizedQuery.includes(normalizedValue)) {
          score += weight * 2
          matchedTerms.add(value!.trim())
        }

        for (const term of queryTerms) {
          if (term.length < 2) continue
          if (normalizedValue.includes(term)) {
            score += weight
            matchedTerms.add(term)
          }
        }
      }

      addMatches(style.commandName, 10)
      addMatches(style.description, 5)
      addMatches(style.category, 5)
      addMatches(style.whenToUse, 4)

      for (const alias of style.aliases || []) addMatches(alias, 9)
      for (const keyword of style.keywords || []) addMatches(keyword, 8)
      for (const example of style.examples || []) addMatches(example, 6)

      if (!score && style.prompt) {
        const promptText = normalizeMatchText(style.prompt)
        for (const term of queryTerms) {
          if (term.length < 2) continue
          if (promptText.includes(term)) {
            score += 1
            matchedTerms.add(term)
          }
        }
      }

      if (score > 0) {
        candidates.push({
          style,
          score,
          matchedTerms: Array.from(matchedTerms).slice(0, 6),
        })
      }
    }

    return candidates
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        return a.style.commandName.localeCompare(b.style.commandName, 'zh-CN')
      })
      .slice(0, limit)
  }

  // ---------------------------------------------------------------------------
  // 配额 & 用量
  // ---------------------------------------------------------------------------

  getQuotaSummary(userId: string, userName: string) {
    return this.userManager.getUserData(userId, userName).then((userData) => {
      const remainingToday = Math.max(0, this.pluginConfig.dailyFreeLimit - userData.dailyUsageCount)
      const totalAvailable = remainingToday + userData.remainingPurchasedCount
      return {
        userId,
        userName: userData.userName,
        remainingToday,
        remainingPurchasedCount: userData.remainingPurchasedCount,
        totalAvailable,
        totalUsageCount: userData.totalUsageCount,
        purchasedCount: userData.purchasedCount,
      }
    })
  }

  checkAndReserveQuota(userId: string, userName: string, numImages: number, platform?: string) {
    return this.userManager.checkAndReserveQuota(
      userId,
      userName,
      numImages,
      this.pluginConfig,
      platform,
    )
  }

  buildGenerationSetup(numImages: number, modifiers?: ImageGenerationModifiers) {
    const requestContext: ImageRequestContext = { numImages }

    if (modifiers?.modelMapping?.provider) {
      requestContext.provider = modifiers.modelMapping.provider
    }
    if (modifiers?.modelMapping?.modelId) {
      requestContext.modelId = modifiers.modelMapping.modelId
    }
    if (modifiers?.resolution) {
      requestContext.resolution = modifiers.resolution
    }
    if (modifiers?.aspectRatio) {
      requestContext.aspectRatio = modifiers.aspectRatio
    }

    const displayInfo: GenerationDisplayInfo = {}
    if (modifiers?.customAdditions?.length) {
      displayInfo.customAdditions = modifiers.customAdditions
    }
    if (modifiers?.modelMapping?.modelId) {
      displayInfo.modelId = modifiers.modelMapping.modelId
      displayInfo.modelDescription = modifiers.modelMapping.suffix || modifiers.modelMapping.modelId
    }

    return { requestContext, displayInfo }
  }

  async recordUsage(
    userId: string,
    userName: string,
    commandName: string,
    numImages: number,
    platform?: string,
  ): Promise<UsageRecordingResult> {
    const isAdmin = this.userManager.isAdmin(userId, this.pluginConfig)
    const isPermanentMember = this.userManager.isPermanentMember(userId, this.pluginConfig)
    const isPlatformExempt = Boolean(
      platform && this.pluginConfig.unlimitedPlatforms?.includes(platform),
    )

    if (isAdmin || isPermanentMember || isPlatformExempt) {
      const userData = await this.userManager.recordUsageOnly(userId, userName, commandName, numImages)
      return {
        totalUsageCount: userData.totalUsageCount,
        remainingPurchasedCount: userData.remainingPurchasedCount,
        remainingToday: Math.max(0, this.pluginConfig.dailyFreeLimit - userData.dailyUsageCount),
        isAdmin,
        isPlatformExempt,
      }
    }

    const result = await this.userManager.consumeQuota(
      userId,
      userName,
      commandName,
      numImages,
      this.pluginConfig,
    )
    return {
      totalUsageCount: result.userData.totalUsageCount,
      remainingPurchasedCount: result.userData.remainingPurchasedCount,
      remainingToday: Math.max(0, this.pluginConfig.dailyFreeLimit - result.userData.dailyUsageCount),
      isAdmin: false,
      isPlatformExempt: false,
    }
  }

  // ---------------------------------------------------------------------------
  // Provider 路由 / 字段拼装
  // ---------------------------------------------------------------------------

  private resolveProvider(requestContext?: ImageRequestContext): ProviderType {
    if (requestContext?.provider) return requestContext.provider

    const cfg = this.pluginConfig
    switch (cfg.provider) {
      case 'openai-compatible':
        return cfg.openaiCompatibleProtocol || 'openai-images'
      case 'openai-official':
        return 'openai-images'
      case 'gemini-official':
        return 'gemini'
      default:
        return 'openai-images'
    }
  }

  private buildProviderFactoryConfig(
    provider: ProviderType,
    requestContext?: ImageRequestContext,
  ): Record<string, unknown> {
    const cfg = this.pluginConfig
    const targetModelId = requestContext?.modelId
    const common = {
      apiTimeout: cfg.apiTimeout,
      logLevel: cfg.logLevel,
    }

    switch (provider) {
      case 'openai-images':
        return {
          ...common,
          apiKey: this.resolveOpenAIImagesApiKey(),
          modelId: targetModelId || this.resolveOpenAIImagesModelId(),
          apiBase: this.resolveOpenAIImagesApiBase(),
          extraHeaders: this.resolveOpenAIImagesExtraHeaders(),
        }
      case 'openai-chat':
        return {
          ...common,
          apiKey: cfg.openaiCompatibleApiKey || '',
          modelId: targetModelId || cfg.openaiCompatibleModelId || DEFAULT_OPENAI_CHAT_MODEL_ID,
          apiBase: cfg.openaiCompatibleApiBase || DEFAULT_OPENAI_API_BASE,
          extraHeaders: cfg.openaiCompatibleExtraHeaders || {},
        }
      case 'gemini':
        return {
          ...common,
          apiKey: cfg.geminiOfficialApiKey || '',
          modelId: targetModelId || cfg.geminiOfficialModelId || '',
          apiBase: cfg.geminiOfficialApiBase || DEFAULT_GEMINI_API_BASE,
        }
      default:
        return { ...common }
    }
  }

  private resolveDefaultModelId(provider: ProviderType): string {
    switch (provider) {
      case 'openai-images':
        return this.resolveOpenAIImagesModelId()
      case 'openai-chat':
        return this.pluginConfig.openaiCompatibleModelId || DEFAULT_OPENAI_CHAT_MODEL_ID
      case 'gemini':
        return this.pluginConfig.geminiOfficialModelId || ''
      default:
        return this.resolveFallbackModelId(provider)
    }
  }

  private resolveOpenAIImagesApiKey(): string {
    const cfg = this.pluginConfig
    return cfg.provider === 'openai-official'
      ? cfg.openaiOfficialApiKey || ''
      : cfg.openaiCompatibleApiKey || cfg.openaiOfficialApiKey || ''
  }

  private resolveOpenAIImagesModelId(): string {
    const cfg = this.pluginConfig
    return cfg.provider === 'openai-official'
      ? cfg.openaiOfficialModelId || DEFAULT_OPENAI_IMAGES_MODEL_ID
      : cfg.openaiCompatibleModelId || cfg.openaiOfficialModelId || DEFAULT_OPENAI_IMAGES_MODEL_ID
  }

  private resolveOpenAIImagesApiBase(): string {
    const cfg = this.pluginConfig
    return cfg.provider === 'openai-official'
      ? cfg.openaiOfficialApiBase || DEFAULT_OPENAI_API_BASE
      : cfg.openaiCompatibleApiBase || cfg.openaiOfficialApiBase || DEFAULT_OPENAI_API_BASE
  }

  private resolveOpenAIImagesExtraHeaders(): Record<string, string> {
    return this.pluginConfig.provider === 'openai-official'
      ? {}
      : this.pluginConfig.openaiCompatibleExtraHeaders || {}
  }

  private resolveFallbackModelId(provider: ProviderType): string {
    switch (provider) {
      case 'openai-images':
        return DEFAULT_OPENAI_IMAGES_MODEL_ID
      case 'openai-chat':
        return DEFAULT_OPENAI_CHAT_MODEL_ID
      case 'gemini':
        return ''
      default:
        return ''
    }
  }

  // ---------------------------------------------------------------------------
  // 内部工具：风格预设收集
  // ---------------------------------------------------------------------------

  private collectStyleDefinitions(config: Config): ResolvedStyleConfig[] {
    const unique = new Map<string, ResolvedStyleConfig>()

    const pushStyle = (style?: StyleConfig, groupName?: string) => {
      if (!style?.commandName || !style?.prompt) return
      if (unique.has(style.commandName)) {
        this.pluginLogger.warn('检测到重复的风格命令名称，已跳过', {
          commandName: style.commandName,
          groupName,
        })
        return
      }
      unique.set(style.commandName, {
        ...style,
        ...(groupName !== undefined ? { groupName } : {}),
      })
    }

    if (Array.isArray(config.styles)) {
      for (const style of config.styles) {
        pushStyle(style)
      }
    }

    if (config.styleGroups && typeof config.styleGroups === 'object') {
      for (const [groupName, group] of Object.entries(config.styleGroups)) {
        if (!groupName || !group || !Array.isArray(group.prompts)) continue
        for (const style of group.prompts) {
          pushStyle(style, groupName)
        }
      }
    }

    return Array.from(unique.values())
  }
}

// ---------------------------------------------------------------------------
// 文件级私有工具
// ---------------------------------------------------------------------------

function normalizeMatchText(value?: string | null): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
}

function buildQueryTerms(query: string): string[] {
  const raw = String(query || '')
    .toLowerCase()
    .trim()

  const compact = raw.replace(/\s+/g, '')
  const splitTerms = raw
    .split(/[\s,，。；;、|/]+/)
    .map(item => item.trim())
    .filter(Boolean)

  const unique = new Set<string>()
  if (compact) unique.add(compact)
  for (const term of splitTerms) {
    unique.add(term.replace(/\s+/g, ''))
  }

  return Array.from(unique)
}
