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
import type { ImageProvider as RuntimeImageProvider, ImageGenerationOptions as ProviderImageGenerationOptions } from '../providers/types.js'
type ImageGenerationOptionsWithContract = ProviderImageGenerationOptions
import type { CreditLedgerEventV2, CreditSummary } from '../services/UserManager.js'
import { UserManager } from '../services/UserManager.js'
import { buildOverviewStats } from '../console/overview-stats.js'
import { MissingModelMappingError, MissingCatalogRouteError } from './model-route-selection.js'
import type { CatalogRouteLookup } from './model-route-selection.js'
import { buildProtocolRequestContext, ContractRejectedParamsError } from '../shared/generation-setup.js'
import type { ContractOperation } from '../contracts/types.js'
import { getContractById, resolveContract } from '../contracts/registry.js'
import type { ImageContract } from '../contracts/types.js'

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
/** 兜底 base；生产由 providerSettings.openaiCompatibleApiBase 覆盖。禁止硬编码特定中转站。 */
const DEFAULT_OPENAI_API_BASE = 'https://api.openai.com'
const DEFAULT_CONTEXT_HISTORY_SIZE = 20

/**
 * requestProviderImages 的 request-scoped 返回：把 provider 生成结果与后生成结算读数
 * （usage tokens / 路由分组 / request-id）打包成同一次调用的局部结果返回，
 * 不再写入 Service 实例级单例字段 —— 消除多用户并发生成时结算读数互相覆盖的竞争。
 */
export interface ProviderImagesResult {
  images: string[]
  usage: {
    totalTokens: number | null
    inputTokens: number | null
    outputTokens: number | null
  }
  /** new-api 响应头 x-routing-group（实际路由分组），后生成结算用。 */
  routingGroup: string | null
  /** 响应头 request-id（x-api-request-id 等），MJ 逐任务结算按此查 /api/log/self。 */
  requestId: string | null
}

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
  ): Promise<ProviderImagesResult> {
    const provider = this.resolveProvider(requestContext)
    const supplier = this.resolveSupplier(requestContext)
    const targetModelId = requestContext?.modelId
    const effectiveModelId = targetModelId || this.resolveDefaultModelId()
    const factoryConfig = this.buildProviderFactoryConfig(provider, requestContext)

    // 定位契约：若 requestContext 提供了 contractId 则精确匹配；否则按当前 mapping+operation 查询。
    const operation: ContractOperation = requestContext?.operation ?? 'text-to-image'
    const contract = this.locateContractForRequest(requestContext, operation)
    if (!contract) {
      throw new Error(`模型 ${effectiveModelId || 'unknown'} 在 ${operation} 操作下没有可用契约（fail-closed）`)
    }

    // fail-closed：contract-driven 分支产生的 rejected 参数在此拦截；
    // 五个入口（普通命令、style、wizard、ChatLuna、YesImBot）都必须先经 buildGenerationSetup
    // 或 buildProtocolRequestContext，理论上不会走到这里，但保留兜底防御防止绕过。
    if (requestContext?.rejectedParams && requestContext.rejectedParams.length > 0) {
      throw new ContractRejectedParamsError(requestContext.rejectedParams)
    }

    const imageOptions: ImageGenerationOptionsWithContract = {
      resolution: requestContext?.resolution,
      aspectRatio: requestContext?.aspectRatio,
      contract,
      operation,
      numImages,
    }
    if (requestContext?.contractFields) {
      imageOptions.contractFields = { ...requestContext.contractFields }
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
    const images = await providerInstance.generateImages(
      prompt,
      imageUrls,
      numImages,
      imageOptions,
      onImageGenerated,
    )

    // request-scoped 结算读数：providerInstance 是按本次请求创建的，其 usage / 路由 / request-id
    // 只属于当前调用，直接打包返回，不写入 Service 单例 —— 避免并发生成时被其它请求覆盖。
    const usage = {
      totalTokens: providerInstance.lastTotalTokens,
      inputTokens: providerInstance.lastInputTokens,
      outputTokens: providerInstance.lastOutputTokens,
    }
    const result: ProviderImagesResult = {
      images,
      usage,
      // new-api 实际路由分组（x-routing-group 响应头）
      routingGroup: providerInstance.lastRoutingGroup,
      // request-id（供 MJ /api/log/self 权威查 quota）
      requestId: providerInstance.lastRequestId,
    }

    this.pluginLogger.info('requestProviderImages 完成', {
      supplier,
      provider,
      resultCount: images.length,
      lastTotalTokens: usage.totalTokens,
      lastInputTokens: usage.inputTokens,
      lastOutputTokens: usage.outputTokens,
      routingGroup: result.routingGroup,
      requestId: result.requestId,
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

  reserveCredits(userId: string, userName: string, requestId: string, cost: GenerationCost, platform?: string, freeForTrialMapping?: boolean) {
    return this.userManager.reserveCredits(userId, userName, requestId, cost, this.pluginConfig, platform, freeForTrialMapping)
  }

  settleReservation(requestId: string, actualImages: number, commandName: string, evidence: Record<string, unknown> | null, modelId?: string) {
    return this.userManager.settleReservation(requestId, actualImages, commandName, this.pluginConfig, evidence, modelId)
  }

  getModelUsageStats() {
    return this.userManager.getModelUsageStats()
  }

  /** 总览页用量统计：聚合全部用户的请求/生成/失败/积分与模型分布。 */
  async getOverviewStats() {
    const users = await this.userManager.getAllUsers()
    return buildOverviewStats(Object.values(users))
  }

  releaseReservation(requestId: string, reason: string) {
    return this.userManager.releaseReservation(requestId, this.pluginConfig, reason)
  }

  /** 免计费平台判断：命中时应完全绕过积分/试用/结算，只保留限流与模型访问控制。 */
  isFreePlatform(platform?: string | null): boolean {
    return platform != null
      && Array.isArray(this.pluginConfig.freePlatforms)
      && this.pluginConfig.freePlatforms.includes(platform)
  }

  /** 免计费平台专用统计增量：不涉及预授权与结算，仅累加 totalImagesGenerated / totalGenerationRequests。 */
  recordUsageOnly(userId: string, userName: string, commandName: string, numImages: number, modelId?: string) {
    return this.userManager.recordUsageOnly(userId, userName, commandName, numImages, this.pluginConfig, modelId)
  }

  /** 目录 route 查询（由 index.ts 注入）；唯一协议来源。 */
  public catalogRouteLookup: CatalogRouteLookup | undefined

  /**
   * 后生成定价构建：使用慷慨预留金额（200 平台积分）替代预计算成本。
   *
   * 同时通过 shared/generation-setup.buildProtocolRequestContext 完成
   * “协议参数规范化 + 缺失值自动补全”：显式值优先，缺失值使用当前协议默认，
   * 未知协议保持保守；MJ 协议的 ar/stylize 会以 promptAppends 返回。
   */
  buildGenerationSetup(
    numImages: number,
    modifiers?: ImageGenerationModifiers,
    operation: ContractOperation = 'text-to-image',
  ) {
    // 使用慷慨预留金额（200 平台积分），不再预计算 exact cost
    const generationCost: GenerationCost = {
      totalCredits: 200,
      creditCostPerImage: 200 / numImages,
      numImages,
      costSource: 'post-generation',
    }

    const modelMapping = modifiers?.modelMapping

    let protocol: string | undefined
    let supplier: ImageProvider | undefined
    let routeId: string | undefined
    let contractId: string | undefined
    if (modelMapping) {
      const resolvedRoute = this.resolveModelRoute(modelMapping, operation)
      supplier = resolvedRoute.supplier
      protocol = resolvedRoute.protocol
      routeId = this.catalogRouteLookup?.(modelMapping.modelId, operation)?.routeId
      contractId = this.resolveContractForMapping(modelMapping, operation)?.id
    }

    const { requestContext, rejectedParams } = buildProtocolRequestContext({
      protocol,
      supplier,
      modelMapping,
      routeId,
      operation,
      contractId,
      explicit: {
        resolution: modifiers?.resolution,
        aspectRatio: modifiers?.aspectRatio,
        numImages,
      },
      defaultNumImages: numImages,
    })

    // 保持传入的 numImages 语义（命令层已用 config.defaultNumImages / -n 决定）
    requestContext.numImages = numImages

    // fail-closed：命令层调用此方法紧接着做计费预授权，任何被契约拒绝的显式参数
    // 都必须在此抛出，避免出现“先扣积分后失败”的静默失真。
    if (rejectedParams && rejectedParams.length > 0) {
      throw new ContractRejectedParamsError(rejectedParams)
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

  /** 由 catalog route 决定的协议查询（未知模型返回 undefined）。 */
  getProtocolForModelId(
    modelId: string | undefined | null,
    operation: ContractOperation = 'text-to-image',
  ): ProviderType | undefined {
    if (!modelId) return undefined
    return this.catalogRouteLookup?.(modelId, operation)?.protocol
  }

  /**
   * 请求期契约定位。优先使用 requestContext.contractId；否则回退 modelId+operation。
   */
  private locateContractForRequest(
    requestContext: ImageRequestContext | undefined,
    operation: ContractOperation,
  ): ImageContract | undefined {
    // 优先精确契约 id
    if (requestContext?.contractId) {
      const contract = getContractById(requestContext.contractId)
      if (contract) return contract
    }
    const modelId = requestContext?.modelId
    if (!modelId) return undefined
    const mapping = this.pluginConfig.modelMappings?.find(m => (requestContext?.modelSuffix ? m.suffix === requestContext.modelSuffix : m.modelId === modelId))
      ?? { suffix: '', modelId }
    return this.resolveContractForMapping(mapping, operation)
  }

  /**
   * 定位 mapping + operation 对应的图像契约。
   * 找不到时返回 undefined；provider 应基于 undefined fail-closed。
   */
  resolveContractForMapping(
    mapping: ModelMappingConfig,
    operation: ContractOperation,
  ): ImageContract | undefined {
    if (!mapping?.modelId) return undefined
    const route = this.catalogRouteLookup?.(mapping.modelId, operation)
    if (!route) return undefined
    const supplier = this.resolveActiveSupplierRoute(route.protocol, mapping)
    const contractSupplier = mapSupplierToContract(this.pluginConfig.activeSupplier, supplier)
    if (!contractSupplier) return undefined
    const result = resolveContract({
      modelId: mapping.modelId,
      supplier: contractSupplier,
      protocol: route.protocol,
      operation,
    })
    return result.ok ? result.contract : undefined
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

  /** 检查模型是否对当前用户可用。若 mapping 未提供，使用配置中第一个映射作为默认。 */
  checkModelAccess(
    userId: string,
    modifiers: ImageGenerationModifiers,
  ): ModelAccessCheckResult {
    const mapping = modifiers?.modelMapping ?? this.getFirstModelMapping()
    if (!mapping?.modelId) return { allowed: false, message: '未配置可用模型映射' }
    if (!mapping.restricted) return { allowed: true }
    if (this.userManager.isModelWhitelisted(userId, this.pluginConfig)) {
      return { allowed: true }
    }
    return {
      allowed: false,
      message: buildRestrictedModelMessage(mapping),
    }
  }

  /**
   * 检查模型是否允许该用户使用。豁免用户（管理员/永久会员/免计费平台）不受限制。
   * 有购买余额的用户放行任意模型（最终扣费由 reserveCredits 原子完成）；
   * 无余额用户仅放行每日免费模型（freeTrialModelId）。
   */
  async checkFreeTrialForModel(
    userId: string,
    mapping: ModelMappingConfig,
    platform?: string,
  ): Promise<ModelAccessCheckResult> {
    const isExempt = this.userManager.isAdmin(userId, this.pluginConfig)
      || this.userManager.isPermanentMember(userId, this.pluginConfig)
      || (platform != null && Array.isArray(this.pluginConfig.freePlatforms) && this.pluginConfig.freePlatforms.includes(platform))
    if (isExempt) return { allowed: true }

    // 有购买余额 → 放行任意模型；余额读取失败/无用户记录视为无余额，走原拦截逻辑
    try {
      const userData = await this.userManager.getExistingUserData(userId)
      const purchasedCredits = Number(userData?.balance?.purchasedCredits ?? 0)
      if (Number.isFinite(purchasedCredits) && purchasedCredits > 0) {
        return { allowed: true }
      }
    } catch (error) {
      this.pluginLogger.warn('读取用户购买余额失败，按无余额处理', error)
    }

    const freeModelId = this.pluginConfig.freeTrialModelId
    if (!freeModelId) {
      return {
        allowed: false,
        message: ['未设置每日免费模型', '', '- 说明丨管理员可在 aka-tools 配置页选择每日免费试用模型'].join('\n'),
      }
    }
    if (mapping.modelId === freeModelId) return { allowed: true }
    return {
      allowed: false,
      message: ['模型不在免费列表', '', `- 模型丨${mapping.suffix ? (mapping.suffix.startsWith('-') ? mapping.suffix : `-${mapping.suffix}`) : '该模型'}`, '- 说明丨每日免费仅限管理员指定的模型，请换模型或充值后使用'].join('\n'),
    }
  }

  getFirstModelMapping(): ModelMappingConfig | undefined {
    const mappings = this.pluginConfig.modelMappings
    if (!Array.isArray(mappings) || mappings.length === 0) return undefined
    // 目录校验后，跳过失效映射（modelId 不在当前供应商目录中）
    const available = mappings.filter(m => !this.unavailableModelIds.has(m.modelId))
    return available[0] ?? mappings[0]
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

  private resolveModelRoute(
    mapping: ModelMappingConfig,
    operation: ContractOperation = 'text-to-image',
  ): { supplier: ImageProvider; protocol: ProviderType } {
    const route = this.catalogRouteLookup?.(mapping.modelId, operation)
    if (!route) throw new MissingCatalogRouteError(mapping.modelId, operation)
    const supplier = this.resolveActiveSupplierRoute(route.protocol, mapping)
    this.assertRouteSupported(supplier, route.protocol, mapping)
    return { supplier, protocol: route.protocol }
  }

  /** activeSupplier → 运行时凭证入口（ImageProvider） */
  private resolveActiveSupplierRoute(protocol: ProviderType, mapping?: ModelMappingConfig): ImageProvider {
    const active = this.pluginConfig.activeSupplier as string | undefined
    if (active === 'newapi' || active === 'gptgod' || active === 'yunwu') return 'openai-compatible'
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

  // 更下方的 private getFirstModelMapping 实现已移至上方公共方法，这里保留注释说明即可
  // (no code here)

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
          apiBase: normalizeApiBase(settings.openaiCompatibleApiBase) || DEFAULT_OPENAI_API_BASE,
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

function mapSupplierToContract(
  activeSupplier: string | undefined,
  supplier: ImageProvider,
): 'newapi' | 'openai-official' | 'gemini-official' | undefined {
  if (activeSupplier === 'newapi' || activeSupplier === 'yunwu' || activeSupplier === 'gptgod') return 'newapi'
  if (activeSupplier === 'openai-official') return 'openai-official'
  if (activeSupplier === 'gemini-official') return 'gemini-official'
  if (supplier === 'openai-compatible') return 'newapi'
  if (supplier === 'gpt-official') return 'openai-official'
  if (supplier === 'gemini-official') return 'gemini-official'
  return undefined
}

function normalizeApiBase(base?: string): string | undefined {
  if (!base) return undefined
  return base.replace(/\/$/, '').replace(/\/v1\/?$/, '')
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
