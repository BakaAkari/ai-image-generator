import type { Config } from './config.js'
import type { ImageGenerationModifiers, ModelMappingConfig } from './types.js'

export interface GenerationCost {
  totalCredits: number
  creditCostPerImage: number
  numImages: number
  modelId?: string
  modelSuffix?: string
  costSource: 'default' | 'model-fixed' | 'catalog-auto'
}

export interface CalculateGenerationCostParams {
  numImages: number
  modelMapping?: ModelMappingConfig
  config: Config
  /** 目录计价查询（0.9.0 自动换算）；未注入时退回默认单价 */
  catalogPricingLookup?: (modelId: string) => { type: string; pricePerCall?: number; tokenRatio?: number } | undefined
}

/** per-token 模型的每张图 token 量经验估算（gpt-image-2 系一张 1k 图约 1600-2400 token） */
const ESTIMATED_TOKENS_PER_IMAGE = 2000
/** new-api token 计费基础单价（美元/百万 token），平台基准 */
const TOKEN_BASE_PRICE_PER_MILLION = 2

export function calculateGenerationCost(params: CalculateGenerationCostParams): GenerationCost {
  const numImages = normalizePositiveInteger(params.numImages, 1)
  const defaultCost = normalizeNonNegativeNumber(params.config.defaultCreditCostPerImage, 1)
  const modelCost = normalizeOptionalNonNegativeNumber(params.modelMapping?.creditCostPerImage)
  let creditCostPerImage = modelCost ?? defaultCost
  let costSource: GenerationCost['costSource'] = modelCost === undefined ? 'default' : 'model-fixed'

  // 0.9.0：映射积分价留空时，按动态目录计价自动换算（成本 × 汇率 × 加成）
  if (modelCost === undefined && params.modelMapping?.modelId && params.catalogPricingLookup) {
    const pricing = params.catalogPricingLookup(params.modelMapping.modelId)
    const rate = params.config.creditExchangeRate ?? 1000
    const markup = params.config.costMarkup ?? 1.3
    let costUsd: number | null = null
    if (pricing?.type === 'per-call' && typeof pricing.pricePerCall === 'number') {
      costUsd = pricing.pricePerCall
    } else if (pricing?.type === 'per-token' && typeof pricing.tokenRatio === 'number') {
      costUsd = (ESTIMATED_TOKENS_PER_IMAGE / 1_000_000) * TOKEN_BASE_PRICE_PER_MILLION * pricing.tokenRatio
    }
    if (costUsd != null && rate > 0) {
      creditCostPerImage = roundCredits(costUsd * rate * markup)
      costSource = 'catalog-auto'
    }
  }

  return {
    totalCredits: roundCredits(creditCostPerImage * numImages),
    creditCostPerImage,
    numImages,
    ...(params.modelMapping?.modelId ? { modelId: params.modelMapping.modelId } : {}),
    ...(params.modelMapping?.suffix ? { modelSuffix: params.modelMapping.suffix } : {}),
    costSource,
  }
}

export function calculateCostFromModifiers(
  numImages: number,
  modifiers: ImageGenerationModifiers | undefined,
  config: Config,
): GenerationCost {
  return calculateGenerationCost({
    numImages,
    modelMapping: modifiers?.modelMapping,
    config,
  })
}

export function scaleGenerationCost(cost: GenerationCost, actualImages: number): GenerationCost {
  const numImages = normalizePositiveInteger(actualImages, 0)
  return {
    ...cost,
    numImages,
    totalCredits: roundCredits(cost.creditCostPerImage * numImages),
  }
}

export function formatCredits(value: number, unitName = '积分'): string {
  const rounded = roundCredits(value)
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(2)} ${unitName}`
}

export function roundCredits(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(Math.max(0, value) * 100) / 100
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.floor(value || fallback))
}

function normalizeNonNegativeNumber(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return roundCredits(value ?? fallback)
}

function normalizeOptionalNonNegativeNumber(value: number | undefined): number | undefined {
  if (!Number.isFinite(value)) return undefined
  return roundCredits(value ?? 0)
}
