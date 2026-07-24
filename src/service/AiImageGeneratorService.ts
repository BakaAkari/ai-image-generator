/**
 * AiImageGeneratorService —— V2 服务层。
 *
 * 供应商语义 + 协议路由版本：配置页只暴露 OpenAI 兼容 / Gemini 官方 / GPT 官方。
 * 模型映射显式声明 supplier + protocol，运行时只保留 openai / gemini 两类 Provider。
 */

import type { Context, Session } from 'koishi'
import { Service } from 'koishi'

import type { Config, ProviderSettingsConfig } from '../shared/config.js'
import type { GenerationCost } from '../shared/billing.js'
import { computePostGenerationCost, formatCredits, scaleGenerationCost } from '../shared/billing.js'
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
import { isDetailLogLevel, normalizeLogLevel } from '../shared/logging.js'
import { ImageContextStore } from '../core/image-context-store.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { ImageProvider as RuntimeImageProvider } from '../providers/types.js'
import type { CreditLedgerEventV2, CreditSummary } from '../services/UserManager.js'
import { UserManager } from '../services/UserManager.js'
import { MissingModelMappingError, MissingCatalogRouteError } from './model-route-selection.js'

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
  summary: CreditSummary
  consumedCredits: number
  freeUsed: number
  purchasedUsed: number
  isAdmin: boolean
  isPermanentMember: boolean
  isPlatformExempt: boolean
  ledgerEvent?: CreditLedgerEventV2
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
    const effectiveModelId = targetModelId || this.resolveDefaultModelId()
    const factoryConfig = this.buildProviderFactoryConfig(provider, requestContext)
    const imageOptions = {
      resolution: requestContext?.resolution,
      aspectRatio: requestContext?.aspectRatio,
    }

    const requestLog = {
      supplier,
      provider,
      modelId: effectiveModelId || 'default',
      modelSource: targetModelId ? 'requestContext' : 'providerDefault',
      numImages,
      imageUrlsCount: Array.isArray(imageUrls) ? imageUrls.length : (imageUrls ? 1 : 0),
      ...imageOptions,
    }

    this.pluginLogger.info('requestProviderImages 调用', requestLog)

    if (isDetailLogLevel(this.pluginConfig.logLevel)) {
      this.pluginLogger.info('requestProviderImages 诊断', {
        ...requestLog,
        hasCallback: !!onImageGenerated,
        promptLength: prompt.length,
        apiBase: factoryConfig.apiBase || 'default',
        apiKey: factoryConfig.apiKey ? 'configured' : 'missing',
        extraHeaders: redactHeadersForLog(factoryConfig.extraHeaders),
        timeout: factoryConfig.apiTimeout,
      })
    }

    const providerInstance = this.providerRegistry.createProvider(provider, this.ctx, factoryConfig)
    // 重置前一次用量追踪
    this.lastProviderUsage = null
    const result = await providerInstance.generateImages(
      prompt,
      imageUrls,
      numImages,
      imageOptions,
      onImageGenerated,
    )

    // 后生成定价：捕获 provider 返回的 usage.total_tokens
    this.lastProviderUsage = providerInstance.lastTotalTokens

    this.pluginLogger.info('requestProviderImages 完成', {
      supplier,
      provider,
      resultCount: result.length,
      lastTotalTokens: this.lastProviderUsage,
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
    const modelId = params.requestContext?.modelId || this.resolveDefaultModelId()

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

  async getQuotaSummary(userId: string, userName: string): Promise<CreditSummary> {
    const userData = await this.userManager.getUserData(userId, userName, this.pluginConfig)
    return this.userManager.buildCreditSummary(userData, this.pluginConfig)
  }

  async getExistingUsageSummary(userId: string): Promise<CreditSummary | undefined> {
    const userData = await this.userManager.getExistingUserData(userId)
    if (!userData) return undefined
    return this.userManager.buildCreditSummary(userData, this.pluginConfig)
  }

  async getUsageRanking(limit = 10) {
    const users = await this.userManager.getAllUsers()
    return Object.values(users)
      .map(userData => this.userManager.buildCreditSummary(userData, this.pluginConfig))
      .sort((a, b) => {
        if (b.totalConsumedCredits !== a.totalConsumedCredits) return b.totalConsumedCredits - a.totalConsumedCredits
        if (b.totalImagesGenerated !== a.totalImagesGenerated) return b.totalImagesGenerated - a.totalImagesGenerated
        return a.userName.localeCompare(b.userName, 'zh-CN')
      })
      .slice(0, Math.min(50, Math.max(1, Math.floor(limit || 10))))
  }

  reserveCredits(userId: string, userName: string, requestId: string, cost: GenerationCost, platform?: string) {
    return this.userManager.reserveCredits(userId, userName, requestId, cost, this.pluginConfig, platform)
  }

  settleReservation(requestId: string, actualImages: number, commandName: string, evidence: Record<string, unknown> | null) {
    return this.userManager.settleReservation(requestId, actualImages, commandName, this.pluginConfig, evidence)
  }

  releaseReservation(requestId: string, reason: string) {
    return this.userManager.releaseReservation(requestId, this.pluginConfig, reason)
  }

  /** 目录 route 查询（由 index.ts 注入）；唯一协议来源。 */
  /** 最近一次 provider 生成调用返回的 usage.total_tokens（后生成定价用）。 */
  lastProviderUsage: number | null = null

  public catalogRouteLookup: ((modelId: string) => { routeId: string; protocol: ProviderType } | undefined) | undefined

  /**
   * 后生成定价构建：使用慷慨预留金额（200 平台积分）替代预计算成本。
   */
  buildGenerationSetup(numImages: number, modifiers?: ImageGenerationModifiers) {
    const requestContext: ImageRequestContext = { numImages }
    const modelMapping = modifiers?.modelMapping

    // 使用慷慨预留金额（200 平台积分），不再预计算 exact cost
    const generationCost: GenerationCost = {
      totalCredits: 200,
      creditCostPerImage: 200 / numImages,
      numImages,
      costSource: 'post-generation',
    }

    if (modelMapping) {
      const resolvedRoute = this.resolveModelRoute(modelMapping)
      requestContext.supplier = resolvedRoute.supplier
      requestContext.provider = resolvedRoute.protocol
      requestContext.routeId = this.catalogRouteLookup?.(modelMapping.modelId)?.routeId
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

    return { requestContext, displayInfo, generationCost }
  }

  /**
   * @deprecated 0.9.1 不再用于运行时定价。保留兼容 bridge。
   */
  calculateGenerationCost(numImages: number, requestContext?: ImageRequestContext): GenerationCost {
    return {
      totalCredits: 200,
      creditCostPerImage: 200 / numImages,
      numImages,
      costSource: 'post-generation',
    }
  }

  scaleGenerationCost(cost: GenerationCost, actualImages: number): GenerationCost {
    return scaleGenerationCost(cost, actualImages)
  }

  formatCredits(value: number): string {
    return formatCredits(value, this.pluginConfig.creditUnitName)
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


  async grantCredits(
    userId: string,
    userName: string,
    amount: number,
    reason: string,
    operator: { userId: string; userName: string },
  ) {
    return this.userManager.grantCredits(userId, userName, amount, reason, operator, this.pluginConfig)
  }

  async adjustCredits(
    userId: string,
    userName: string,
    amount: number,
    reason: string,
    operator: { userId: string; userName: string },
  ) {
    return this.userManager.adjustCredits(userId, userName, amount, reason, operator, this.pluginConfig)
  }

  listLedgerEvents(userId?: string, limit = 10) {
    return this.userManager.listLedgerEvents(userId, limit)
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

  private resolveDefaultModelId(): string {
    const firstMapping = this.getFirstModelMapping()
    if (!firstMapping?.modelId) throw new MissingModelMappingError()
    return firstMapping.modelId
  }

  private resolveDefaultModelRoute(): { supplier: ImageProvider; protocol: ProviderType } {
    const firstMapping = this.getFirstModelMapping()
    if (!firstMapping) throw new MissingModelMappingError()
    return this.resolveModelRoute(firstMapping)
  }

  private resolveModelRoute(mapping: ModelMappingConfig): { supplier: ImageProvider; protocol: ProviderType } {
    const route = this.catalogRouteLookup?.(mapping.modelId)
    if (!route) throw new MissingCatalogRouteError(mapping.modelId)
    const supplier = this.resolveActiveSupplierRoute(route.protocol, mapping)
    this.assertRouteSupported(supplier, route.protocol, mapping)
    return { supplier, protocol: route.protocol }
  }

  /** activeSupplier → 运行时凭证入口（ImageProvider） */
  private resolveActiveSupplierRoute(protocol: ProviderType, mapping?: ModelMappingConfig): ImageProvider {
    const active = this.pluginConfig.activeSupplier
    if (active === 'gptgod' || active === 'yunwu') return 'openai-compatible'
    if (active === 'openai-official') return 'gpt-official'
    if (active === 'gemini-official') return 'gemini-official'
    // 未配置 activeSupplier（旧配置升级）：沿用 mapping 上的 legacy 字段，保证行为不变
    if (mapping?.supplier) return mapping.supplier
    return this.inferLegacySupplier(mapping?.protocol || mapping?.provider || protocol)
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
    if (!Array.isArray(mappings) || mappings.length === 0) return undefined
    // 目录校验后，跳过失效映射（modelId 不在当前供应商目录中）
    const available = mappings.filter(m => !this.unavailableModelIds.has(m.modelId))
    return available[0] ?? mappings[0]
  }

  /** 目录校验：不在当前供应商目录中的 modelId 集合（目录为空时不校验，避免误伤） */
  private unavailableModelIds = new Set<string>()

  /** 由 index.ts 在目录刷新后调用：重校验映射，返回失效列表用于告警 */
  public revalidateMappings(models: Array<{ id: string }>): string[] {
    this.unavailableModelIds.clear()
    if (!models.length) return []
    const catalogIds = new Set(models.map(m => m.id))
    const invalid: string[] = []
    for (const mapping of this.pluginConfig.modelMappings ?? []) {
      if (!catalogIds.has(mapping.modelId)) {
        this.unavailableModelIds.add(mapping.modelId)
        invalid.push(`${mapping.suffix} → ${mapping.modelId}`)
      }
    }
    return invalid
  }

  /** 映射是否在目录中有效（供计费/命令层查询） */
  public isMappingAvailable(mapping: ModelMappingConfig): boolean {
    return !this.unavailableModelIds.has(mapping.modelId)
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
      logLevel: normalizeLogLevel(cfg.logLevel),
    }

    switch (supplier) {
      case 'openai-compatible':
        return {
          ...common,
          apiKey: settings.openaiCompatibleApiKey || '',
          modelId: targetModelId || this.resolveDefaultModelId(),
          apiBase: provider === 'gemini'
            ? this.resolveOpenAICompatibleGeminiApiBase(settings)
            : settings.openaiCompatibleApiBase || DEFAULT_OPENAI_API_BASE,
          extraHeaders: settings.openaiCompatibleExtraHeaders || {},
        }
      case 'gpt-official':
        return {
          ...common,
          apiKey: settings.gptOfficialApiKey || '',
          modelId: targetModelId || this.resolveDefaultModelId(),
          apiBase: DEFAULT_OPENAI_API_BASE,
          extraHeaders: {},
        }
      case 'gemini-official':
        return {
          ...common,
          apiKey: settings.geminiOfficialApiKey || '',
          modelId: targetModelId || this.resolveDefaultModelId(),
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
