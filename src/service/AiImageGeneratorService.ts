/**
 * AiImageGeneratorService —— V2 服务层。
 *
 * 与 v1（AiGeneratorService）的核心差异：
 * - 服务名改为 `aiImageGenerator`，与 v1 隔离，支持双插件并存。
 * - Provider 实例化路径改用 ProviderRegistry：不再调用 createImageProvider()，
 *   而是 `providerRegistry.createProvider(name, ctx, config)`。
 * - Schema 标签 `ImageProvider`（用户配置）→ Registry 名（运行期）做集中映射：
 *     'yunwu'  → 'yunwu-adaptive'
 *     'openai' → 'openai-images'
 *     其它同名（gemini / gptgod / grok / gpt-official）。
 * - 各 Provider 工厂只接收自己用到的字段（apiKey/modelId/apiBase/apiFormat...），
 *   Service 在此处按 provider 标签做字段映射，Provider 内部不再需要 .hidden() 反模式。
 * - 范围限定为图像生成。视频相关字段、方法、UsageReporter 耦合全部移除。
 */

import type { Context, Session } from 'koishi'
import { Service } from 'koishi'

import type { Config } from '../shared/config.js'
import type {
  ApiFormat,
  GeneratedImageRecord,
  GenerationDisplayInfo,
  ImageGenerationModifiers,
  ImageProvider as ImageProviderTag,
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

/**
 * 默认 API base（仅作为 Provider 工厂的 fallback；Schema 已为大多数分支提供默认值，
 * 这里再兜一层避免运行期出现 undefined）。
 */
const DEFAULT_GEMINI_API_BASE = 'https://generativelanguage.googleapis.com'
const DEFAULT_GROK_API_BASE = 'https://yunwu.ai'
const DEFAULT_OPENAI_API_BASE = 'https://api.openai.com/v1'
const DEFAULT_GPT_OFFICIAL_API_BASE = 'https://api.openai.com'
const DEFAULT_YUNWU_API_BASE = 'https://yunwu.ai'

const DEFAULT_GROK_MODEL_ID = 'grok-3-image'
const DEFAULT_OPENAI_MODEL_ID = 'gpt-image-1'
const DEFAULT_GPT_OFFICIAL_MODEL_ID = 'gpt-image-1'

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
  // Provider 实例化（核心改造点）
  // ---------------------------------------------------------------------------

  /**
   * 根据 requestContext / pluginConfig 决定使用哪个 provider，并通过 ProviderRegistry
   * 即时构造一个 ImageProvider 实例。
   *
   * - requestContext.provider 优先（如模型映射切走、ChatLuna 工具调用强制切换）
   * - 否则使用 pluginConfig.provider（Schema 标签 ImageProvider）
   * - 内部映射：Schema 标签 → Registry 名
   */
  getProviderInstance(requestContext?: ImageRequestContext): RuntimeImageProvider {
    const { providerTag, registryName } = this.resolveProviderTarget(requestContext)
    const factoryConfig = this.buildProviderFactoryConfig(providerTag, requestContext)
    return this.providerRegistry.createProvider(registryName, this.ctx, factoryConfig)
  }

  /**
   * 调用底层 Provider 完成一次图像生成请求。
   *
   * 与 v1 完全等价的对外行为：
   * - 输入 imageUrls 可为单 URL 或数组
   * - 透传 onImageGenerated 回调（用于流式发图）
   * - 日志结构化（key=value），对接 7.11.8 节日志规范
   */
  async requestProviderImages(
    prompt: string,
    imageUrls: string | string[],
    numImages: number,
    requestContext?: ImageRequestContext,
    onImageGenerated?: (imageUrl: string, index: number, total: number) => void | Promise<void>,
  ): Promise<string[]> {
    const { providerTag } = this.resolveProviderTarget(requestContext)
    const targetModelId = requestContext?.modelId
    const imageOptions = {
      resolution: requestContext?.resolution,
      aspectRatio: requestContext?.aspectRatio,
    }

    this.pluginLogger.info('requestProviderImages 调用', {
      providerTag,
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
      providerTag,
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

    const { providerTag, registryName } = this.resolveProviderTarget(params.requestContext)
    const modelId = params.requestContext?.modelId
      || this.resolveDefaultModelId(providerTag)

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
        provider: registryName,
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
        maxRecordsPerConversation: this.pluginConfig.chatlunaContextHistorySize,
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

  /**
   * 根据 ImageGenerationModifiers 构建 ImageRequestContext + 展示信息。
   *
   * 注：v2 命令层鼓励直接构造 ImageRequestContext；保留此辅助方法是为了
   * - 兼容 cherry-pick 自 v1 的 parser.ts 逻辑（仍然返回 modifiers）
   * - 避免命令层重复实现样式映射
   */
  buildGenerationSetup(numImages: number, modifiers?: ImageGenerationModifiers) {
    const requestContext: ImageRequestContext = { numImages }

    if (modifiers?.modelMapping?.provider) {
      requestContext.provider = this.tagToProviderType(
        modifiers.modelMapping.provider as ImageProviderTag,
      )
    }
    if (modifiers?.modelMapping?.modelId) {
      requestContext.modelId = modifiers.modelMapping.modelId
    }
    if (modifiers?.modelMapping?.apiFormat) {
      requestContext.apiFormat = modifiers.modelMapping.apiFormat
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
  // 内部工具：Provider 标签映射 / 字段拼装
  // ---------------------------------------------------------------------------

  /**
   * 将 Schema 标签（'yunwu' / 'openai' / ...）映射为 ProviderRegistry 注册名 +
   * 运行期 ProviderType。
   *
   * - 优先使用 requestContext.provider（已经是 ProviderType 字面量；模型映射时强切走）
   * - 否则用 pluginConfig.provider（ImageProvider 标签）
   */
  private resolveProviderTarget(
    requestContext?: ImageRequestContext,
  ): { providerTag: ImageProviderTag; registryName: ProviderType } {
    if (requestContext?.provider) {
      const registryName = requestContext.provider
      const providerTag = this.providerTypeToTag(requestContext.provider)
      return { providerTag, registryName }
    }

    const providerTag = (this.pluginConfig.provider || 'yunwu') as ImageProviderTag
    return { providerTag, registryName: this.tagToRegistryName(providerTag) }
  }

  private tagToRegistryName(tag: ImageProviderTag): ProviderType {
    switch (tag) {
      case 'yunwu':
        return 'yunwu-adaptive'
      case 'openai':
        return 'openai-images'
      case 'gptgod':
      case 'gemini':
      case 'grok':
      case 'gpt-official':
        return tag
      default:
        // 类型安全兜底：穷尽检查后未匹配，回退到云雾默认
        return 'yunwu-adaptive'
    }
  }

  /** ProviderType (registry name) → ImageProvider 标签（用于回写到 pluginConfig 字段名） */
  private providerTypeToTag(providerType: ProviderType): ImageProviderTag {
    switch (providerType) {
      case 'yunwu-adaptive':
        return 'yunwu'
      case 'openai-images':
        return 'openai'
      case 'gemini':
      case 'gptgod':
      case 'grok':
      case 'gpt-official':
        return providerType
      default:
        return 'yunwu'
    }
  }

  /** ImageProvider 标签 → ProviderType（用于命令层根据用户选择构造 ImageRequestContext.provider） */
  private tagToProviderType(tag: ImageProviderTag): ProviderType {
    switch (tag) {
      case 'yunwu':
        return 'yunwu-adaptive'
      case 'openai':
        return 'openai-images'
      case 'gptgod':
      case 'gemini':
      case 'grok':
      case 'gpt-official':
        return tag
      default:
        return 'yunwu-adaptive'
    }
  }

  /**
   * 根据当前 provider 标签从 pluginConfig 中提取该 provider 用得到的字段，
   * 拼装出 ProviderFactory 期望的 config（apiKey/modelId/apiBase/...）。
   *
   * 这一步替代了 v1 的 createImageProvider 工厂中"传一大堆字段然后内部 switch"的模式。
   */
  private buildProviderFactoryConfig(
    providerTag: ImageProviderTag,
    requestContext?: ImageRequestContext,
  ): Record<string, unknown> {
    const cfg = this.pluginConfig
    const targetModelId = requestContext?.modelId

    const common = {
      apiTimeout: cfg.apiTimeout,
      logLevel: cfg.logLevel,
    }

    switch (providerTag) {
      case 'yunwu': {
        const apiFormat: ApiFormat = (requestContext?.apiFormat || cfg.yunwuApiFormat || 'gemini')
        return {
          ...common,
          apiKey: cfg.yunwuApiKey || '',
          modelId: targetModelId || cfg.yunwuModelId || '',
          apiBase: cfg.yunwuApiBase || DEFAULT_YUNWU_API_BASE,
          apiFormat,
        }
      }
      case 'gptgod':
        return {
          ...common,
          apiKey: cfg.gptgodApiKey || '',
          modelId: targetModelId || cfg.gptgodModelId || '',
        }
      case 'gemini':
        return {
          ...common,
          apiKey: cfg.geminiApiKey || '',
          modelId: targetModelId || cfg.geminiModelId || '',
          apiBase: cfg.geminiApiBase || DEFAULT_GEMINI_API_BASE,
        }
      case 'grok':
        return {
          ...common,
          apiKey: cfg.grokApiKey || '',
          modelId: targetModelId || cfg.grokModelId || DEFAULT_GROK_MODEL_ID,
          apiBase: cfg.grokApiBase || DEFAULT_GROK_API_BASE,
        }
      case 'openai':
        return {
          ...common,
          apiKey: cfg.openaiApiKey || '',
          modelId: targetModelId || cfg.openaiModelId || DEFAULT_OPENAI_MODEL_ID,
          apiBase: cfg.openaiApiBase || DEFAULT_OPENAI_API_BASE,
        }
      case 'gpt-official':
        return {
          ...common,
          apiKey: cfg.gptOfficialApiKey || '',
          modelId: targetModelId || cfg.gptOfficialModelId || DEFAULT_GPT_OFFICIAL_MODEL_ID,
          apiBase: cfg.gptOfficialApiBase || DEFAULT_GPT_OFFICIAL_API_BASE,
        }
      default:
        return { ...common }
    }
  }

  /** 根据 provider 标签返回该 provider 的默认 modelId（用于记录 / 显示） */
  private resolveDefaultModelId(providerTag: ImageProviderTag): string {
    const cfg = this.pluginConfig
    switch (providerTag) {
      case 'yunwu':
        return cfg.yunwuModelId || ''
      case 'gptgod':
        return cfg.gptgodModelId || ''
      case 'gemini':
        return cfg.geminiModelId || ''
      case 'grok':
        return cfg.grokModelId || DEFAULT_GROK_MODEL_ID
      case 'openai':
        return cfg.openaiModelId || DEFAULT_OPENAI_MODEL_ID
      case 'gpt-official':
        return cfg.gptOfficialModelId || DEFAULT_GPT_OFFICIAL_MODEL_ID
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
