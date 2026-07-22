import type { SupplierPriceInfo } from '../catalog/model-catalog.js'

export type PriceQuoteKind = 'catalog-quote' | 'actual' | 'estimate' | 'fallback'

export interface CostQuote {
  costUsdPerImage?: number
  creditsPerImage?: number
  totalCostUsd?: number
  totalCredits?: number
  chargeable: boolean
  numImages: number
  kind: PriceQuoteKind
  pricingMode: 'per-call' | 'per-token' | 'unknown'
  fallback: boolean
  evidence: {
    modelId: string
    catalogPriceInfo?: SupplierPriceInfo
    creditExchangeRate: number
    costMarkup: number
    explanation: string
  }
}

export interface ChargePolicy {
  creditExchangeRate: number
  costMarkup: number
  defaultCreditsPerImage: number
  overrideCreditsPerImage?: Record<string, number>
  fallbackToDefault: boolean
}

export interface QuoteParams {
  modelId: string
  numImages: number
  mappingCreditCostPerImage?: number
}

export class PricingEngine {
  constructor(private readonly policy: ChargePolicy) {}

  quote(params: QuoteParams, catalogPriceInfo?: SupplierPriceInfo): CostQuote {
    const numImages = normalizePositiveInteger(params.numImages, 1)
    const override = this.policy.overrideCreditsPerImage?.[params.modelId]

    if (typeof override === 'number') {
      return this.buildQuote({
        modelId: params.modelId,
        numImages,
        costUsdPerImage: override / this.policy.creditExchangeRate / this.policy.costMarkup,
        creditsPerImage: override,
        kind: 'catalog-quote',
        pricingMode: 'per-call',
        fallback: false,
        explanation: 'model mapping credit cost override',
        catalogPriceInfo,
      })
    }

    if (typeof params.mappingCreditCostPerImage === 'number') {
      return this.buildQuote({
        modelId: params.modelId,
        numImages,
        costUsdPerImage: params.mappingCreditCostPerImage / this.policy.creditExchangeRate / this.policy.costMarkup,
        creditsPerImage: params.mappingCreditCostPerImage,
        kind: 'catalog-quote',
        pricingMode: 'per-call',
        fallback: false,
        explanation: 'model mapping credit cost per image',
        catalogPriceInfo,
      })
    }

    if (catalogPriceInfo) {
      if (catalogPriceInfo.quotaType === 1 && typeof catalogPriceInfo.modelPrice === 'number') {
        const costUsdPerImage = catalogPriceInfo.modelPrice
        return this.buildQuote({
          modelId: params.modelId,
          numImages,
          costUsdPerImage,
          creditsPerImage: this.toCredits(costUsdPerImage),
          kind: 'catalog-quote',
          pricingMode: 'per-call',
          fallback: false,
          explanation: 'per-call catalog model_price',
          catalogPriceInfo,
        })
      }

      if (catalogPriceInfo.quotaType === 0) {
        return this.buildUnknownQuote({
          modelId: params.modelId,
          numImages,
          pricingMode: 'per-token',
          explanation: 'per-token catalog ratios preserved; request cost formula unavailable',
          catalogPriceInfo,
        })
      }
    }

    if (this.policy.fallbackToDefault) {
      return this.buildQuote({
        modelId: params.modelId,
        numImages,
        costUsdPerImage: this.policy.defaultCreditsPerImage / this.policy.creditExchangeRate / this.policy.costMarkup,
        creditsPerImage: this.policy.defaultCreditsPerImage,
        kind: 'fallback',
        pricingMode: 'unknown',
        fallback: true,
        explanation: 'no catalog pricing available, fallback to defaultCreditCostPerImage',
        catalogPriceInfo,
      })
    }

    throw new PricingNotAvailableError(params.modelId)
  }

  private toCredits(costUsd: number): number {
    return roundCredits(costUsd * this.policy.creditExchangeRate * this.policy.costMarkup)
  }

  private buildQuote(opts: {
    modelId: string
    numImages: number
    costUsdPerImage: number
    creditsPerImage: number
    kind: PriceQuoteKind
    pricingMode: 'per-call' | 'per-token' | 'unknown'
    fallback: boolean
    explanation: string
    catalogPriceInfo?: SupplierPriceInfo
  }): CostQuote {
    return {
      chargeable: true,
      costUsdPerImage: opts.costUsdPerImage,
      creditsPerImage: opts.creditsPerImage,
      totalCostUsd: opts.costUsdPerImage * opts.numImages,
      totalCredits: roundCredits(opts.creditsPerImage * opts.numImages),
      numImages: opts.numImages,
      kind: opts.kind,
      pricingMode: opts.pricingMode,
      fallback: opts.fallback,
      evidence: {
        modelId: opts.modelId,
        catalogPriceInfo: opts.catalogPriceInfo,
        creditExchangeRate: this.policy.creditExchangeRate,
        costMarkup: this.policy.costMarkup,
        explanation: opts.explanation,
      },
    }
  }

  private buildUnknownQuote(opts: {
    modelId: string
    numImages: number
    pricingMode: 'per-token' | 'unknown'
    explanation: string
    catalogPriceInfo?: SupplierPriceInfo
  }): CostQuote {
    return {
      chargeable: false,
      numImages: opts.numImages,
      kind: 'estimate',
      pricingMode: opts.pricingMode,
      fallback: false,
      evidence: {
        modelId: opts.modelId,
        catalogPriceInfo: opts.catalogPriceInfo,
        creditExchangeRate: this.policy.creditExchangeRate,
        costMarkup: this.policy.costMarkup,
        explanation: opts.explanation,
      },
    }
  }
}

export class PricingNotAvailableError extends Error {
  constructor(public readonly modelId: string) {
    super(`无法为模型 ${modelId} 获取目录价格，且未启用默认回退`)
    this.name = 'PricingNotAvailableError'
  }
}

export function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.floor(value || fallback))
}

export function roundCredits(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(Math.max(0, value) * 100) / 100
}
