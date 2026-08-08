import type { Config } from './config.js'
import type { ImageGenerationModifiers, ModelMappingConfig } from './types.js'

/**
 * OpenLux / NewAPI 兼容站的 model_price 与日志 quota：
 *   真实美元 = quota / 500000（门户「计费过程」显示的真实扣费单位；充值/余额铁证 2026-08-06）
 *   per-call 真实扣费 = 模型 price × 分组倍率（表值即真）
 *   per-token 真实扣费 = eff_tokens × tokenRatio × 分组倍率 / 500000
 *
 * 汇率使用快照值（2026-08-06 open.er-api.com USD/CNY ≈ 6.76）；需定期人工/cron 更新。
 * 可通过 config.usdToRmb 覆盖。
 */
export const USD_TO_RMB = 6.76

/** @deprecated 改名为 USD_TO_RMB（美元→人民币）；同值别名仅供旧外部引用。 */
export const SUPPLIER_CREDIT_TO_RMB = USD_TO_RMB

/** 按配置返回 USD→CNY 汇率；未配置或无效时用默认 6.76。 */
export function resolveUsdToRmb(configValue?: number): number {
  return typeof configValue === 'number' && Number.isFinite(configValue) && configValue > 0
    ? configValue
    : USD_TO_RMB
}

/** @deprecated 改名为 resolveUsdToRmb。同语义别名仅供旧外部引用。 */
export const resolveSupplierCreditToRmb = resolveUsdToRmb

/**
 * OpenLux / NewAPI per-token 计费的 quota 除数。
 *
 * 真相：门户「计费过程」显示的真实美元 = quota / 500000（对 MJ、gpt-image、gemini 等所有模型一致）。
 * 例：MJ mj_imagine 一次真实扣费 $0.013236 = 0.3(model_price) × 0.04412(group_ratio)；
 *     gemini 一次真实扣费 $0.012169 = 0.1655 × 0.07353。
 *
 * 此前（错误）以 5000 为除数：把 `/v1/dashboard/billing/usage.total_usage`（=真实美元×100）
 * 当成美元读数后再逆推的假象值；两处误读叠加恰好差 100 倍。
 * 可通过 config.quotaPerUnit 覆盖以适配自建站的非标 QuotaPerUnit。
 */
export const DEFAULT_QUOTA_PER_UNIT = 500000

/**
 * per-token 模型预扣的 raw prompt token 估算基线。默认 2000 覆盖 XL prompt 观察上限。
 * 结算按精确 usage × completionRatio 4dp 多退少补；上界预扣仅用于预授权。
 */
export const DEFAULT_PER_TOKEN_ESTIMATE = 2000

/** @deprecated 改名为 DEFAULT_PER_TOKEN_ESTIMATE。同值别名仅供旧外部引用。 */
export const DEFAULT_TOKEN_ESTIMATE = DEFAULT_PER_TOKEN_ESTIMATE

interface ExchangeConfigLike {
  creditsPerCny?: number
  pricingMarkupPercent?: number
  usdToRmb?: number
  /** @deprecated 改用 usdToRmb；此处保留仅为旧调用点/迁移窗口兼容。 */
  supplierCreditToRmb?: number
}

/**
 * 从 config 解析 USD→CNY 汇率：优先 usdToRmb（新语义），回落到 supplierCreditToRmb（deprecated，
 * migration 窗口内兼容），最终默认 6.76。
 */
function resolveExchangeRateFromConfig(config: ExchangeConfigLike): number {
  if (typeof config.usdToRmb === 'number' && Number.isFinite(config.usdToRmb) && config.usdToRmb > 0) {
    return config.usdToRmb
  }
  if (typeof config.supplierCreditToRmb === 'number' && Number.isFinite(config.supplierCreditToRmb) && config.supplierCreditToRmb > 0) {
    return config.supplierCreditToRmb
  }
  return USD_TO_RMB
}

/** 从 config 解析 OpenLux quota 除数；无效或缺失时回退 500000（真实美元 = quota/500000）。 */
function resolveQuotaPerUnit(configValue?: number): number {
  return typeof configValue === 'number' && Number.isFinite(configValue) && configValue > 0
    ? configValue
    : DEFAULT_QUOTA_PER_UNIT
}

/** 从 config 解析 per-token 预扣估算；无效或缺失时回退 2000。 */
function resolvePerTokenEstimate(configValue?: number): number {
  return typeof configValue === 'number' && Number.isFinite(configValue) && configValue > 0
    ? configValue
    : DEFAULT_PER_TOKEN_ESTIMATE
}

/**
 * 后生成定价：将 usage.totalTokens × tokenRatio 转换为供应商积分（USD 口径）。
 * 公式：totalTokens × tokenRatio / quotaPerUnit（默认 500000）
 */
export function tokensToSupplierCredits(totalTokens: number, tokenRatio = 1, quotaPerUnit: number = DEFAULT_QUOTA_PER_UNIT): number {
  const safe = typeof totalTokens === 'number' && Number.isFinite(totalTokens) && totalTokens > 0 ? totalTokens : 0
  const ratio = Number.isFinite(tokenRatio) && tokenRatio > 0 ? tokenRatio : 1
  const divisor = resolveQuotaPerUnit(quotaPerUnit)
  return safe * ratio / divisor
}

/**
 * 后生成定价：从供应商积分（USD）计算最终平台积分成本。
 * 公式：supplierCredits(USD) × usdToRmb × creditsPerCny × (1 + pricingMarkupPercent/100)
 */
export function computePostGenerationCost(
  supplierCredits: number,
  config: ExchangeConfigLike,
  opts?: { round?: boolean },
): number {
  const safeSupplierCredits = typeof supplierCredits === 'number' && Number.isFinite(supplierCredits) && supplierCredits > 0 ? supplierCredits : 0
  const creditsPerCny = Number(config.creditsPerCny)
  const validCreditsPerCny = Number.isFinite(creditsPerCny) && creditsPerCny > 0 ? creditsPerCny : 0
  const markupPercent = config.pricingMarkupPercent
  const validMarkup = typeof markupPercent === 'number' && Number.isFinite(markupPercent) && markupPercent >= 0 ? markupPercent : 0
  const markupMultiplier = 1 + validMarkup / 100
  const exchangeRate = resolveExchangeRateFromConfig(config)
  const raw = safeSupplierCredits * exchangeRate * validCreditsPerCny * markupMultiplier
  return opts?.round === false ? roundCreditsPrecise(raw, 4) : roundCredits(raw)
}

/** 计价所需的目录模型宽度（不含 catalog 依赖）。 */
export interface CatalogModelForPricing {
  id: string
  pricing?: {
    type: string
    pricePerCall?: number
    tokenRatio?: number
    officialPriceInput?: number
    officialPriceOutput?: number
    completionRatio?: number
    /** 该模型开放的分组（new-api 系），用于动态倍率上界。 */
    enableGroups?: string[]
  }
}

/**
 * 预生成估价：直接从目录模型读取计价参数，结算后多退少补（通过 settleReservation）。
 * 返回 GenerationCost 供积分预授权使用。
 */
export function estimatePreGenerationCost(
  modelId: string,
  config: ExchangeConfigLike & { quotaPerUnit?: number; perTokenEstimateTokens?: number },
  catalogModels: CatalogModelForPricing[],
  groupRatio = 1,
): GenerationCost {
  const model = catalogModels.find(m => m.id === modelId)
  const pricing = model?.pricing

  const safeRatio = Number.isFinite(groupRatio) && groupRatio > 0 ? groupRatio : 1
  const divisor = resolveQuotaPerUnit(config.quotaPerUnit)
  const tokenEstimate = resolvePerTokenEstimate(config.perTokenEstimateTokens)

  let supplierCredits: number

  if (!model || !pricing || pricing.type === 'unknown') {
    // unknown / 无定价：取目录中最高 per-call 价格作为保守预估值
    const knownPrices = catalogModels
      .map(m => (m.pricing?.type === 'per-call' ? m.pricing.pricePerCall : 0) ?? 0)
      .filter((p): p is number => p > 0)
    supplierCredits = knownPrices.length > 0 ? Math.max(...knownPrices) * safeRatio : tokenEstimate / divisor * safeRatio
  } else if (pricing.type === 'per-call' && typeof pricing.pricePerCall === 'number' && pricing.pricePerCall > 0) {
    supplierCredits = pricing.pricePerCall * safeRatio
  } else if (pricing.type === 'per-token') {
    // per-token 模型：按 new-api 权威公式估算（quota=(prompt+completion×completionRatio)×model_ratio；美元=quota/quotaPerUnit=500000）
    // 预扣时无真实 tokens，用 perTokenEstimateTokens × (1+completionRatio) 作为保守上界
    const completionRatio = typeof pricing.completionRatio === 'number' && pricing.completionRatio > 0 ? pricing.completionRatio : 1
    const ratio = typeof pricing.tokenRatio === 'number' && pricing.tokenRatio > 0 ? pricing.tokenRatio : 1
    supplierCredits = tokenEstimate * (1 + completionRatio) * ratio / divisor * safeRatio
  } else {
    // 定价类型不可识别：同 unknown 分支
    const knownPrices = catalogModels
      .map(m => (m.pricing?.type === 'per-call' ? m.pricing.pricePerCall : 0) ?? 0)
      .filter((p): p is number => p > 0)
    supplierCredits = knownPrices.length > 0 ? Math.max(...knownPrices) * safeRatio : tokenEstimate / divisor * safeRatio
  }

  const totalCredits = computePostGenerationCost(supplierCredits, config)
  return {
    totalCredits,
    creditCostPerImage: totalCredits,
    numImages: 1,
    modelId,
    costSource: 'post-generation',
  }
}

/**
 * 后生成结算：直接从目录快照读取计价参数，计算供应商积分（USD 口径）。
 * 返回的是 USD 值，需再经 computePostGenerationCost 转换为平台积分。
 */
export function computeSupplierCreditsFromCatalog(
  modelId: string,
  totalTokens: number | null,
  catalogModels: CatalogModelForPricing[],
  groupRatio = 1,
  quotaPerUnit: number = DEFAULT_QUOTA_PER_UNIT,
): number {
  const model = catalogModels.find(m => m.id === modelId)
  const pricing = model?.pricing
  const safeRatio = Number.isFinite(groupRatio) && groupRatio > 0 ? groupRatio : 1
  const divisor = resolveQuotaPerUnit(quotaPerUnit)

  if (!model || !pricing || pricing.type === 'unknown') {
    // unknown / 缺失：bare minimum fallback
    return (totalTokens ?? 0) / divisor * safeRatio
  }

  if (pricing.type === 'per-call' && typeof pricing.pricePerCall === 'number' && pricing.pricePerCall > 0) {
    return pricing.pricePerCall * safeRatio
  }

  if (pricing.type === 'per-token') {
    // 对齐 new-api text_quota.go 分支 A：quota = (prompt + completion×completionRatio) × model_ratio × group_ratio
    // USD = quota / quotaPerUnit（默认 500000）。无 input/output 拆分时按 total × completionRatio 保守估算。
    const completionRatio = typeof pricing.completionRatio === 'number' && pricing.completionRatio > 0 ? pricing.completionRatio : 1
    const ratio = typeof pricing.tokenRatio === 'number' && pricing.tokenRatio > 0 ? pricing.tokenRatio : 1
    const tokens = typeof totalTokens === 'number' && Number.isFinite(totalTokens) && totalTokens > 0 ? totalTokens : 0
    return tokens * completionRatio * ratio / divisor * safeRatio
  }

  // fallback
  return (totalTokens ?? 0) / divisor * safeRatio
}

/**
 * 按「分组倍率表」计算预扣上界（动态倍率定价）。
 *
 * 公式：model_price(或 per-token 估算) × max(enable_groups 的 group_ratio) × n 等效单价
 * 返回的是**单张** USD 值。groupRatioMap 为 /api/pricing 的 group_ratio 全表。
 *
 * - 若传入 ratioOverride（mapping.ratioOverride）：直接使用该倍率，跳过 enable_groups 查表；
 * - 模型无 enable_groups / 表中无匹配分组时：回退 fallbackRatio；
 * - 模型无定价时：回退目录最高 per-call 价 × 使用的倍率。
 *
 * opts.quotaPerUnit / opts.perTokenEstimate：per-token 分支使用，未传则用默认 500000 / 2000。
 */
export function computeUpperBoundSupplierCredits(
  modelId: string,
  catalogModels: CatalogModelForPricing[],
  groupRatioMap: Record<string, number> | undefined,
  fallbackRatio = 1,
  ratioOverride?: number,
  opts?: { quotaPerUnit?: number; perTokenEstimate?: number },
): number {
  const model = catalogModels.find(m => m.id === modelId)
  const pricing = model?.pricing
  const safeFallback = Number.isFinite(fallbackRatio) && fallbackRatio > 0 ? fallbackRatio : 1
  const divisor = resolveQuotaPerUnit(opts?.quotaPerUnit)
  const tokenEstimate = resolvePerTokenEstimate(opts?.perTokenEstimate)

  const hasOverride = typeof ratioOverride === 'number' && Number.isFinite(ratioOverride) && ratioOverride > 0
  const upperRatio = hasOverride
    ? ratioOverride!
    : resolveUpperBoundRatio(pricing?.enableGroups, groupRatioMap, safeFallback)

  if (!model || !pricing || pricing.type === 'unknown') {
    const knownPrices = catalogModels
      .map(m => (m.pricing?.type === 'per-call' ? m.pricing.pricePerCall : 0) ?? 0)
      .filter((p): p is number => p > 0)
    return (knownPrices.length > 0 ? Math.max(...knownPrices) : tokenEstimate / divisor) * upperRatio
  }

  if (pricing.type === 'per-call' && typeof pricing.pricePerCall === 'number' && pricing.pricePerCall > 0) {
    return pricing.pricePerCall * upperRatio
  }

  if (pricing.type === 'per-token') {
    // 预扣上界：无真实 tokens，用 perTokenEstimateTokens × (1+completionRatio)（假定全部为补全 token，保证上界充分）
    // 公式对齐 new-api text_quota.go 分支 A：quota = (prompt + completion×completionRatio) × model_ratio × group_ratio
    // USD = quota / quotaPerUnit（默认 500000）
    const completionRatio = typeof pricing.completionRatio === 'number' && pricing.completionRatio > 0 ? pricing.completionRatio : 1
    const ratio = typeof pricing.tokenRatio === 'number' && pricing.tokenRatio > 0 ? pricing.tokenRatio : 1
    return tokenEstimate * (1 + completionRatio) * ratio / divisor * upperRatio
  }

  return (tokenEstimate / divisor) * upperRatio
}

/**
 * 按「实际路由分组」计算结算供应商积分（动态倍率定价，单张，USD 口径）。
 *
 * 公式：model_price(或 per-token 实际 usage) × group_ratio[实际分组]。
 * routingGroup 来自生成响应头 x-routing-group；ratio 解析失败回退 default→1。
 * quotaPerUnit：per-token 除数，未传则用默认 500000。
 */
export function computeActualSupplierCredits(
  modelId: string,
  totalTokens: number | null,
  catalogModels: CatalogModelForPricing[],
  actualRatio: number,
  inputTokens?: number | null,
  outputTokens?: number | null,
  quotaPerUnit: number = DEFAULT_QUOTA_PER_UNIT,
): number {
  const safeRatio = Number.isFinite(actualRatio) && actualRatio > 0 ? actualRatio : 1
  const divisor = resolveQuotaPerUnit(quotaPerUnit)
  const model = catalogModels.find(m => m.id === modelId)
  const pricing = model?.pricing

  if (!model || !pricing || pricing.type === 'unknown') {
    return (totalTokens ?? 0) / divisor * safeRatio
  }

  if (pricing.type === 'per-call' && typeof pricing.pricePerCall === 'number' && pricing.pricePerCall > 0) {
    return pricing.pricePerCall * safeRatio
  }

  if (pricing.type === 'per-token') {
    // 对齐 new-api text_quota.go 分支 A：quota = (prompt + completion×completionRatio) × model_ratio × group_ratio
    // USD = quota / quotaPerUnit（默认 500000）。有 input/output 拆分时精确计算；否则按 total × completionRatio（保守上界）估算。
    const completionRatio = typeof pricing.completionRatio === 'number' && pricing.completionRatio > 0 ? pricing.completionRatio : 1
    const ratio = typeof pricing.tokenRatio === 'number' && pricing.tokenRatio > 0 ? pricing.tokenRatio : 1
    const hasSplit = typeof inputTokens === 'number' && Number.isFinite(inputTokens) && inputTokens >= 0 &&
      typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens >= 0
    const effective = hasSplit
      ? inputTokens + outputTokens * completionRatio
      : (typeof totalTokens === 'number' && Number.isFinite(totalTokens) && totalTokens > 0 ? totalTokens * completionRatio : 0)
    return effective * ratio / divisor * safeRatio
  }

  return (totalTokens ?? 0) / divisor * safeRatio
}

/** 取 enable_groups 在 groupRatioMap 中的最大倍率；无则回退 fallbackRatio。 */
export function resolveUpperBoundRatio(
  enableGroups: string[] | undefined,
  groupRatioMap: Record<string, number> | undefined,
  fallbackRatio = 1,
): number {
  if (Array.isArray(enableGroups) && enableGroups.length > 0 && groupRatioMap) {
    let max = -1
    for (const group of enableGroups) {
      const ratio = groupRatioMap[group]
      if (typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0 && ratio > max) max = ratio
    }
    if (max >= 0) return max
  }
  return Number.isFinite(fallbackRatio) && fallbackRatio > 0 ? fallbackRatio : 1
}

export interface GenerationCost {
  totalCredits: number
  creditCostPerImage: number
  numImages: number
  modelId?: string
  modelSuffix?: string
  /** `post-generation` 为生成后按实际 usage 计价。旧类型不再使用。 */
  costSource: 'model-fixed' | 'catalog-auto' | 'post-generation'
}

export interface CalculateGenerationCostParams {
  numImages: number
  modelMapping?: ModelMappingConfig
  config: Config
}

export class GenerationPricingUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GenerationPricingUnavailableError'
  }
}

/**
 * @deprecated 不再用于运行时定价。保留兼容 bridge 调用，返回宽裕预留积分。
 * 新定价使用 `computePostGenerationCost` 基于 usage.total_tokens 计算。
 */
export function calculateGenerationCost(params: CalculateGenerationCostParams): GenerationCost {
  const numImages = normalizePositiveInteger(params.numImages, 1)
  const mapping = params.modelMapping

  // 返回宽裕预留积分（200 积分/张），bridge 不再需要精确预估值
  const GENEROUS_RESERVATION_PER_IMAGE = 200
  return {
    totalCredits: roundCredits(GENEROUS_RESERVATION_PER_IMAGE * numImages),
    creditCostPerImage: GENEROUS_RESERVATION_PER_IMAGE,
    numImages,
    modelId: mapping?.modelId,
    ...(mapping?.suffix ? { modelSuffix: mapping.suffix } : {}),
    costSource: 'post-generation',
  }
}

/**
 * @deprecated 保留仅用于 bridge 调用兼容。
 */
export function calculateCostFromModifiers(
  numImages: number,
  modifiers: ImageGenerationModifiers | undefined,
  config: Config,
): GenerationCost {
  return calculateGenerationCost({ numImages, modelMapping: modifiers?.modelMapping, config })
}

/**
 * @deprecated 保留仅用于 bridge 调用兼容。
 */
export function scaleGenerationCost(cost: GenerationCost, actualImages: number): GenerationCost {
  const numImages = normalizePositiveInteger(actualImages, 0)
  return { ...cost, numImages, totalCredits: roundCredits(cost.creditCostPerImage * numImages) }
}

export function formatCredits(value: number, unitName = '积分'): string {
  const rounded = roundCredits(value)
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(2)} ${unitName}`
}

export function roundCredits(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(Math.max(0, value) * 100) / 100
}

/**
 * 高精度积分四舍五入：默认保留 4 位小数。仅用于结算记账（settleReservation 非试用路径），
 * 避免 per-token 模型微额消耗被 2 位取整吞没。展示层仍走 roundCredits (2dp)。
 */
export function roundCreditsPrecise(value: number, dp = 4): number {
  if (!Number.isFinite(value)) return 0
  const safe = Math.max(0, value)
  const scale = Math.pow(10, Math.max(0, Math.floor(dp)))
  return Math.round(safe * scale) / scale
}

/**
 * 解析映射级固定积分（simple 模式）：返回每张固定积分，未配置时返回 null。
 * 仅 simple 模式（或未显式 auto）短路结算；auto 模式永远返回 null，走公式链。
 * 读取 creditCostPerImage（schema 认可字段）。
 */
export function resolveMappingFixedCost(
  mapping?: ModelMappingConfig | null,
  configMode?: string,
): number | null {
  if (configMode === 'auto') return null
  if (!mapping) return null
  const direct = mapping.creditCostPerImage
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return direct
  return null
}

/**
 * 迁移期兼容：把 `cost-plus`（旧遗留）视作 `auto`；`fixed`/`disabled` 原样传递；
 * 没有 policy 但存在旧 `creditCostPerImage` 数字时视作 fixed，否则默认 auto。
 */
function resolveEffectivePolicy(mapping: ModelMappingConfig): ModelChargePolicyLegacy | undefined {
  const policy = (mapping as unknown as Record<string, unknown>).chargePolicy as ModelChargePolicyLegacy | undefined
  if (policy) {
    if (policy.type === 'cost-plus') return { type: 'auto' }
    return policy
  }
  if (typeof mapping.creditCostPerImage === 'number' && Number.isFinite(mapping.creditCostPerImage)) {
    return { type: 'fixed', creditsPerImage: mapping.creditCostPerImage }
  }
  return { type: 'auto' }
}

type ModelChargePolicyLegacy =
  | { type: 'auto' }
  | { type: 'fixed'; creditsPerImage: number }
  | { type: 'disabled'; reason: string }
  | { type: 'cost-plus'; acceptEstimated?: boolean }

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.floor(value || fallback))
}
