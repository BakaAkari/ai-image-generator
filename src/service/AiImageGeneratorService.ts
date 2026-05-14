/**
 * AiImageGeneratorService —— V2 服务层。
 *
 * 供应商语义 + 协议路由版本：配置页只暴露 OpenAI 兼容 / Gemini 官方 / GPT 官方。
 * 模型映射显式声明 supplier + protocol，运行时只保留 openai / gemini 两类 Provider。
 */

import type { Context, Session } from 'koishi'
import { Service } from 'koishi'

import type { Config, ProviderSettingsConfig } from '../shared/config.js'
import type {
  GeneratedImageRecord,
  GenerationDisplayInfo,
  ImageGenerationModifiers,
  ImageRequestContext,
  ModelMappingConfig,
  ImageProvider,
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

export interface ModelAccessCheckResult {
  allowed: boolean
  message?: string
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
const DEFAULT_OPENAI_MODEL_ID = 'gpt-image-2'
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
    const supplier = this.resolveSupplier(requestContext)
    const targetModelId = requestContext?.modelId
    const effectiveModelId = targetModelId || this.resolveDefaultModelId(provider)
    const factoryConfig = this.buildProviderFactoryConfig(provider, requestContext)
    const imageOptions = {
      resolution: requestContext?.resolution,
      aspectRatio: requestContext?.aspectRatio,
    }

    this.pluginLogger.info('requestProviderImages 调用', {
      supplier,
      provider,
      modelId: effectiveModelId || 'default',
      modelSource: targetModelId ? 'requestContext' : 'providerDefault',
      numImages,
      hasCallback: !!onImageGenerated,
      promptLength: prompt.length,
      imageUrlsCount: Array.isArray(imageUrls) ? imageUrls.length : (imageUrls ? 1 : 0),
      apiBase: factoryConfig.apiBase || 'default',
      apiKey: factoryConfig.apiKey ? 'configured' : 'missing',
      extraHeaders: redactHeadersForLog(factoryConfig.extraHeaders),
      timeout: factoryConfig.apiTimeout,
      ...imageOptions,
    })

    const providerInstance = this.providerRegistry.createProvider(provider, this.ctx, factoryConfig)
    const result = await providerInstance.generateImages(
      prompt,
      imageUrls,
      numImages,
      imageOptions,
      onImageGenerated,
    )

    this.pluginLogger.info('requestProviderImages 完成', {
      supplier,
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
    const supplier = this.resolveSupplier(params.requestContext)
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
        supplier,
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
      const remainingToday = this.calculateRemainingToday(userData)
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

  async getExistingUsageSummary(userId: string) {
    const userData = await this.userManager.getExistingUserData(userId)
    if (!userData) return undefined
    const remainingToday = this.calculateRemainingToday(userData)
    return {
      userId,
      userName: userData.userName || userId,
      dailyUsageCount: this.calculateTodayUsage(userData),
      remainingToday,
      remainingPurchasedCount: userData.remainingPurchasedCount,
      totalAvailable: remainingToday + userData.remainingPurchasedCount,
      totalUsageCount: userData.totalUsageCount,
    }
  }

  async getUsageRanking(limit = 10) {
    const users = await this.userManager.getAllUsers()
    return Object.values(users)
      .map((userData) => {
        const remainingToday = this.calculateRemainingToday(userData)
        return {
          userId: userData.userId,
          userName: userData.userName || userData.userId,
          totalUsageCount: userData.totalUsageCount,
          dailyUsageCount: this.calculateTodayUsage(userData),
          remainingPurchasedCount: userData.remainingPurchasedCount,
          totalAvailable: remainingToday + userData.remainingPurchasedCount,
        }
      })
      .sort((a, b) => {
        if (b.totalUsageCount !== a.totalUsageCount) return b.totalUsageCount - a.totalUsageCount
        return a.userName.localeCompare(b.userName, 'zh-CN')
      })
      .slice(0, Math.min(50, Math.max(1, Math.floor(limit || 10))))
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
    const modelMapping = modifiers?.modelMapping

    if (modelMapping) {
      const resolvedRoute = this.resolveModelRoute(modelMapping)
      requestContext.supplier = resolvedRoute.supplier
      requestContext.provider = resolvedRoute.protocol
    }
    if (modelMapping?.modelId) {
      requestContext.modelId = modelMapping.modelId
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
    if (modelMapping?.modelId) {
      displayInfo.modelId = modelMapping.modelId
      displayInfo.modelDescription = modelMapping.suffix || modelMapping.modelId
    }

    return { requestContext, displayInfo }
  }

  checkModelAccess(userId: string, modifiers?: ImageGenerationModifiers): ModelAccessCheckResult {
    const mapping = modifiers?.modelMapping
    if (!mapping?.restricted) return { allowed: true }

    if (this.userManager.isModelWhitelisted(userId, this.pluginConfig)) {
      return { allowed: true }
    }

    return {
      allowed: false,
      message: buildRestrictedModelMessage(mapping),
    }
  }

  private calculateTodayUsage(userData: { dailyUsageCount: number; lastDailyReset?: string; createdAt?: string }): number {
    const today = new Date().toDateString()
    const lastReset = new Date(userData.lastDailyReset || userData.createdAt || Date.now()).toDateString()
    return today === lastReset ? userData.dailyUsageCount : 0
  }

  private calculateRemainingToday(userData: { dailyUsageCount: number; lastDailyReset?: string; createdAt?: string }): number {
    return Math.max(0, this.pluginConfig.dailyFreeLimit - this.calculateTodayUsage(userData))
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
        remainingToday: this.calculateRemainingToday(userData),
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
      remainingToday: this.calculateRemainingToday(result.userData),
      isAdmin: false,
      isPlatformExempt: false,
    }
  }

  // ---------------------------------------------------------------------------
  // Provider 路由 / 字段拼装
  // ---------------------------------------------------------------------------

  private resolveProvider(requestContext?: ImageRequestContext): ProviderType {
    if (requestContext?.provider) return requestContext.provider
    return this.resolveDefaultModelRoute().protocol
  }

  private resolveSupplier(requestContext?: ImageRequestContext): ImageProvider {
    if (requestContext?.supplier) return requestContext.supplier
    return this.resolveDefaultModelRoute().supplier
  }

  private resolveDefaultProvider(): ProviderType {
    return this.resolveDefaultModelRoute().protocol
  }

  private resolveDefaultModelId(provider: ProviderType): string {
    const firstMapping = this.getFirstModelMapping()
    if (firstMapping?.modelId) return firstMapping.modelId
    switch (provider) {
      case 'openai':
        return DEFAULT_OPENAI_MODEL_ID
      case 'gemini':
        return ''
      default:
        return ''
    }
  }

  private resolveDefaultModelRoute(): { supplier: ImageProvider; protocol: ProviderType } {
    const firstMapping = this.getFirstModelMapping()
    if (firstMapping) return this.resolveModelRoute(firstMapping)
    return { supplier: 'openai-compatible', protocol: 'openai' }
  }

  private resolveModelRoute(mapping: ModelMappingConfig): { supplier: ImageProvider; protocol: ProviderType } {
    const protocol = mapping.protocol || mapping.provider || 'openai'
    const supplier = mapping.supplier || this.inferLegacySupplier(protocol)
    this.assertRouteSupported(supplier, protocol, mapping)
    return { supplier, protocol }
  }

  private inferLegacySupplier(protocol: ProviderType): ImageProvider {
    if (protocol !== 'gemini') return 'openai-compatible'

    const settings = this.resolveProviderSettings()
    if (settings.geminiOfficialApiKey) return 'gemini-official'
    if (settings.openaiCompatibleApiKey || settings.openaiCompatibleApiBase) return 'openai-compatible'
    return 'gemini-official'
  }

  private assertRouteSupported(
    supplier: ImageProvider,
    protocol: ProviderType,
    mapping?: ModelMappingConfig,
  ) {
    const suffix = mapping?.suffix ? ` suffix=${mapping.suffix}` : ''
    if (supplier === 'gemini-official' && protocol !== 'gemini') {
      throw new Error(`模型映射配置错误｜gemini-official 只能使用 gemini 协议${suffix ? `｜${suffix.trim()}` : ''}`)
    }
    if (supplier === 'gpt-official' && protocol !== 'openai') {
      throw new Error(`模型映射配置错误｜gpt-official 只能使用 openai 协议${suffix ? `｜${suffix.trim()}` : ''}`)
    }
  }

  private getFirstModelMapping(): ModelMappingConfig | undefined {
    const mappings = this.pluginConfig.modelMappings
    if (Array.isArray(mappings) && mappings.length > 0) return mappings[0]
    return undefined
  }

  private buildProviderFactoryConfig(
    provider: ProviderType,
    requestContext?: ImageRequestContext,
  ): Record<string, unknown> {
    const cfg = this.pluginConfig
    const settings = this.resolveProviderSettings()
    const targetModelId = requestContext?.modelId
    const supplier = this.resolveSupplier(requestContext)
    this.assertRouteSupported(supplier, provider)
    const common = {
      apiTimeout: cfg.apiTimeout,
      logLevel: cfg.logLevel,
    }

    switch (supplier) {
      case 'openai-compatible':
        return {
          ...common,
          apiKey: settings.openaiCompatibleApiKey || '',
          modelId: targetModelId || this.resolveDefaultModelId(provider),
          apiBase: provider === 'gemini'
            ? this.resolveOpenAICompatibleGeminiApiBase(settings)
            : settings.openaiCompatibleApiBase || DEFAULT_OPENAI_API_BASE,
          extraHeaders: settings.openaiCompatibleExtraHeaders || {},
        }
      case 'gpt-official':
        return {
          ...common,
          apiKey: settings.gptOfficialApiKey || '',
          modelId: targetModelId || this.resolveDefaultModelId('openai'),
          apiBase: DEFAULT_OPENAI_API_BASE,
          extraHeaders: {},
        }
      case 'gemini-official':
        return {
          ...common,
          apiKey: settings.geminiOfficialApiKey || '',
          modelId: targetModelId || this.resolveDefaultModelId('gemini'),
          apiBase: DEFAULT_GEMINI_API_BASE,
        }
      default:
        return { ...common }
    }
  }

  private resolveOpenAICompatibleGeminiApiBase(settings: ProviderSettingsConfig): string {
    if (settings.openaiCompatibleApiBase) {
      const base = settings.openaiCompatibleApiBase.replace(/\/$/, '')
      // 云雾等第三方通常使用 /v1beta 路径，但如果 base 已含 /v1 则去掉 /v1 后缀
      if (base.endsWith('/v1')) {
        return base.replace(/\/v1$/, '')
      }
      return base
    }
    return DEFAULT_GEMINI_API_BASE
  }

  private resolveProviderSettings(): ProviderSettingsConfig {
    const cfg = this.pluginConfig
    const nested = cfg.providerSettings || {}
    return {
      openaiCompatibleApiKey: nested.openaiCompatibleApiKey || cfg.openaiCompatibleApiKey,
      openaiCompatibleApiBase: nested.openaiCompatibleApiBase || cfg.openaiCompatibleApiBase,
      openaiCompatibleExtraHeaders: nested.openaiCompatibleExtraHeaders || cfg.openaiCompatibleExtraHeaders,
      gptOfficialApiKey: nested.gptOfficialApiKey || cfg.gptOfficialApiKey,
      geminiOfficialApiKey: nested.geminiOfficialApiKey || cfg.geminiOfficialApiKey,
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

function buildRestrictedModelMessage(mapping: ModelMappingConfig): string {
  const suffix = mapping.suffix?.trim()
  const suffixLabel = suffix
    ? (suffix.startsWith('-') ? suffix : `-${suffix}`)
    : '该模型'
  return ['模型受限', '', `- 模型｜${suffixLabel}`, '- 要求｜管理员或模型白名单'].join('\n')
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

function redactHeadersForLog(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string') continue
    const lower = key.toLowerCase()
    result[key] = lower === 'authorization'
      || lower.includes('api-key')
      || lower.includes('apikey')
      || lower.includes('token')
      || lower.includes('secret')
      ? '[REDACTED]'
      : item.slice(0, 120)
  }
  return result
}
