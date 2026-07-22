import type { Config } from './config.js'
import type { ImageGenerationModifiers, ModelMappingConfig } from './types.js'

export interface GenerationCost {
  totalCredits: number
  creditCostPerImage: number
  numImages: number
  modelId?: string
  modelSuffix?: string
  costSource: 'model-fixed' | 'catalog-auto'
}

export interface CalculateGenerationCostParams {
  numImages: number
  modelMapping?: ModelMappingConfig
  config: Config
  catalogPricingLookup?: (modelId: string) => { type: string; pricePerCall?: number; tokenRatio?: number } | undefined
}

export class GenerationPricingUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GenerationPricingUnavailableError'
  }
}

export function calculateGenerationCost(params: CalculateGenerationCostParams): GenerationCost {
  const numImages = normalizePositiveInteger(params.numImages, 1)
  const mapping = params.modelMapping
  if (!mapping?.modelId) throw new GenerationPricingUnavailableError('未配置模型收费策略')

  const policy = mapping.chargePolicy
    ?? (typeof mapping.creditCostPerImage === 'number'
      ? { type: 'fixed' as const, creditsPerImage: mapping.creditCostPerImage }
      : undefined)
  if (!policy) throw new GenerationPricingUnavailableError(`模型 ${mapping.modelId} 未配置收费策略`)
  if (policy.type === 'disabled') throw new GenerationPricingUnavailableError(policy.reason)

  let creditCostPerImage: number
  let costSource: GenerationCost['costSource']

  if (policy.type === 'fixed') {
    creditCostPerImage = roundCredits(policy.creditsPerImage)
    costSource = 'model-fixed'
  } else {
    const pricing = params.catalogPricingLookup?.(mapping.modelId)
    if (pricing?.type !== 'per-call' || typeof pricing.pricePerCall !== 'number') {
      throw new GenerationPricingUnavailableError(`模型 ${mapping.modelId} 当前目录价格无法计算，已拒绝生成`)
    }
    const rate = params.config.creditExchangeRate
    const markup = params.config.costMarkup
    if (!Number.isFinite(rate) || !Number.isFinite(markup) || Number(rate) <= 0 || Number(markup) <= 0) {
      throw new GenerationPricingUnavailableError('cost-plus 策略缺少有效的积分汇率或加成倍率')
    }
    creditCostPerImage = roundCredits(pricing.pricePerCall * Number(rate) * Number(markup))
    costSource = 'catalog-auto'
  }

  return {
    totalCredits: roundCredits(creditCostPerImage * numImages),
    creditCostPerImage,
    numImages,
    modelId: mapping.modelId,
    ...(mapping.suffix ? { modelSuffix: mapping.suffix } : {}),
    costSource,
  }
}

export function calculateCostFromModifiers(
  numImages: number,
  modifiers: ImageGenerationModifiers | undefined,
  config: Config,
): GenerationCost {
  return calculateGenerationCost({ numImages, modelMapping: modifiers?.modelMapping, config })
}

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

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.floor(value || fallback))
}
