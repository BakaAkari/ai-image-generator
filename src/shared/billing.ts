import type { Config } from './config.js'
import type { ImageGenerationModifiers, ModelMappingConfig } from './types.js'

export interface GenerationCost {
  totalCredits: number
  creditCostPerImage: number
  numImages: number
  modelId?: string
  modelSuffix?: string
  costSource: 'default' | 'model-fixed'
}

export interface CalculateGenerationCostParams {
  numImages: number
  modelMapping?: ModelMappingConfig
  config: Config
}

export function calculateGenerationCost(params: CalculateGenerationCostParams): GenerationCost {
  const numImages = normalizePositiveInteger(params.numImages, 1)
  const defaultCost = normalizeNonNegativeNumber(params.config.defaultCreditCostPerImage, 1)
  const modelCost = normalizeOptionalNonNegativeNumber(params.modelMapping?.creditCostPerImage)
  const creditCostPerImage = modelCost ?? defaultCost

  return {
    totalCredits: roundCredits(creditCostPerImage * numImages),
    creditCostPerImage,
    numImages,
    ...(params.modelMapping?.modelId ? { modelId: params.modelMapping.modelId } : {}),
    ...(params.modelMapping?.suffix ? { modelSuffix: params.modelMapping.suffix } : {}),
    costSource: modelCost === undefined ? 'default' : 'model-fixed',
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
