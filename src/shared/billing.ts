import type { Config } from './config.js'
import type { ImageGenerationModifiers, ModelMappingConfig } from './types.js'

/**
 * 供应商积分与人民币的约定汇率（1 供应商积分 = ¥0.5，yunwu 官方口径）。
 * 与 `catalog/billing-info.ts` 的 PLATFORM_CREDIT_TO_RMB 保持一致；此处内嵌是为了
 * 避免 shared/billing.ts 反向依赖 catalog 子模块，同时让运行时定价公式清晰自证。
 */
export const SUPPLIER_CREDIT_TO_RMB = 0.5

/**
 * 后生成定价：将 usage.totalTokens × tokenRatio 转换为供应商积分。
 * 公式：totalTokens * tokenRatio / 500000
 */
export function tokensToSupplierCredits(totalTokens: number, tokenRatio = 1): number {
  const safe = typeof totalTokens === 'number' && Number.isFinite(totalTokens) && totalTokens > 0 ? totalTokens : 0
  const ratio = Number.isFinite(tokenRatio) && tokenRatio > 0 ? tokenRatio : 1
  return safe * ratio / 500000
}

/**
 * 后生成定价：从供应商积分计算最终平台积分成本。
 * 公式：supplierCredits × 0.5 × creditsPerCny × (1 + pricingMarkupPercent/100)
 */
export function computePostGenerationCost(
  supplierCredits: number,
  config: { creditsPerCny?: number; pricingMarkupPercent?: number },
): number {
  const safeSupplierCredits = typeof supplierCredits === 'number' && Number.isFinite(supplierCredits) && supplierCredits > 0 ? supplierCredits : 0
  const creditsPerCny = Number(config.creditsPerCny)
  const validCreditsPerCny = Number.isFinite(creditsPerCny) && creditsPerCny > 0 ? creditsPerCny : 0
  const markupPercent = config.pricingMarkupPercent
  const validMarkup = typeof markupPercent === 'number' && Number.isFinite(markupPercent) && markupPercent >= 0 ? markupPercent : 0
  const markupMultiplier = 1 + validMarkup / 100
  return roundCredits(safeSupplierCredits * SUPPLIER_CREDIT_TO_RMB * validCreditsPerCny * markupMultiplier)
}

/**
 * 后生成定价默认 token 估计值（per-token 模型预扣时使用）。
 */
export const DEFAULT_TOKEN_ESTIMATE = 15000

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
  }
}

/**
 * 预生成估价：直接从目录模型读取计价参数，结算后多退少补（通过 settleReservation）。
 * 返回 GenerationCost 供积分预授权使用。
 */
export function estimatePreGenerationCost(
  modelId: string,
  config: { creditsPerCny?: number; pricingMarkupPercent?: number },
  catalogModels: CatalogModelForPricing[],
  groupRatio = 1,
): GenerationCost {
  const model = catalogModels.find(m => m.id === modelId)
  const pricing = model?.pricing

  const safeRatio = Number.isFinite(groupRatio) && groupRatio > 0 ? groupRatio : 1

  let supplierCredits: number

  if (!model || !pricing || pricing.type === 'unknown') {
    // unknown / 无定价：取目录中最高 per-call 价格作为保守预估值
    const knownPrices = catalogModels
      .map(m => (m.pricing?.type === 'per-call' ? m.pricing.pricePerCall : 0) ?? 0)
      .filter((p): p is number => p > 0)
    supplierCredits = knownPrices.length > 0 ? Math.max(...knownPrices) * safeRatio : DEFAULT_TOKEN_ESTIMATE / 500000 * safeRatio
  } else if (pricing.type === 'per-call' && typeof pricing.pricePerCall === 'number' && pricing.pricePerCall > 0) {
    supplierCredits = pricing.pricePerCall * safeRatio
  } else if (pricing.type === 'per-token') {
    // per-token 模型：使用官方定价 officialPriceOutput（每 1M tokens 的供应商积分）
    const outputPrice = typeof pricing.officialPriceOutput === 'number' && pricing.officialPriceOutput > 0
      ? pricing.officialPriceOutput
      : (typeof pricing.tokenRatio === 'number' ? pricing.tokenRatio * 5 : 5)
    supplierCredits = DEFAULT_TOKEN_ESTIMATE / 1_000_000 * outputPrice * safeRatio
  } else {
    // 定价类型不可识别：同 unknown 分支
    const knownPrices = catalogModels
      .map(m => (m.pricing?.type === 'per-call' ? m.pricing.pricePerCall : 0) ?? 0)
      .filter((p): p is number => p > 0)
    supplierCredits = knownPrices.length > 0 ? Math.max(...knownPrices) * safeRatio : DEFAULT_TOKEN_ESTIMATE / 500000 * safeRatio
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
 * 后生成结算：直接从目录快照读取计价参数，计算供应商积分。
 * 返回的是供应商积分值，需再经 computePostGenerationCost 转换为平台积分。
 */
export function computeSupplierCreditsFromCatalog(
  modelId: string,
  totalTokens: number | null,
  catalogModels: CatalogModelForPricing[],
  groupRatio = 1,
): number {
  const model = catalogModels.find(m => m.id === modelId)
  const pricing = model?.pricing
  const safeRatio = Number.isFinite(groupRatio) && groupRatio > 0 ? groupRatio : 1

  if (!model || !pricing || pricing.type === 'unknown') {
    // unknown / 缺失：bare minimum fallback
    return (totalTokens ?? 0) / 500000 * safeRatio
  }

  if (pricing.type === 'per-call' && typeof pricing.pricePerCall === 'number' && pricing.pricePerCall > 0) {
    return pricing.pricePerCall * safeRatio
  }

  if (pricing.type === 'per-token') {
    const tokens = typeof totalTokens === 'number' && Number.isFinite(totalTokens) && totalTokens > 0 ? totalTokens : 0
    // 使用官方定价 officialPriceOutput（每 1M tokens 的供应商积分）
    const outputPrice = typeof pricing.officialPriceOutput === 'number' && pricing.officialPriceOutput > 0
      ? pricing.officialPriceOutput
      : (typeof pricing.tokenRatio === 'number' ? pricing.tokenRatio * 5 : 5)
    return tokens / 1_000_000 * outputPrice * safeRatio
  }

  // fallback
  return (totalTokens ?? 0) / 500000 * safeRatio
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
 * @deprecated 0.9.1 起不再用于运行时定价。保留兼容 bridge 调用，返回宽裕预留积分。
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
 * @deprecated 0.9.1 保留仅用于 bridge 调用兼容。
 */
export function calculateCostFromModifiers(
  numImages: number,
  modifiers: ImageGenerationModifiers | undefined,
  config: Config,
): GenerationCost {
  return calculateGenerationCost({ numImages, modelMapping: modifiers?.modelMapping, config })
}

/**
 * @deprecated 0.9.1 保留仅用于 bridge 调用兼容。
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
 * 迁移期兼容：把 `cost-plus`（0.9.0 遗留）视作 `auto`；`fixed`/`disabled` 原样传递；
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
