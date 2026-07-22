import { describe, test, expect } from 'vitest'
import { PricingEngine, PricingNotAvailableError } from '../../src/pricing/pricing.js'
import type { SupplierPriceInfo } from '../../src/catalog/model-catalog.js'

describe('PricingEngine', () => {
  const policy = {
    creditExchangeRate: 1000,
    costMarkup: 1.3,
    defaultCreditsPerImage: 1,
    fallbackToDefault: true,
  }
  const engine = new PricingEngine(policy)

  test('per-call model uses catalog model_price', () => {
    const info: SupplierPriceInfo = {
      quotaType: 1,
      modelPrice: 0.014,
      source: 'remote-pricing',
    }
    const quote = engine.quote({ modelId: 'dall-e-3', numImages: 2 }, info)
    expect(quote.pricingMode).toBe('per-call')
    expect(quote.creditsPerImage).toBe(18.2) // 0.014 * 1000 * 1.3
    expect(quote.totalCredits).toBe(36.4)
    expect(quote.kind).toBe('catalog-quote')
  })

  test('per-token model without an explicit formula is unknown and not chargeable', () => {
    const info: SupplierPriceInfo = {
      quotaType: 0,
      modelRatio: 0.875,
      imageRatio: 1.6,
      completionRatio: 6,
      source: 'remote-pricing',
    }
    const quote = engine.quote({ modelId: 'gpt-image-2', numImages: 1 }, info)
    expect(quote.pricingMode).toBe('per-token')
    expect(quote.kind).toBe('estimate')
    expect(quote.chargeable).toBe(false)
    expect(quote.costUsdPerImage).toBeUndefined()
    expect(quote.creditsPerImage).toBeUndefined()
    expect(quote.totalCredits).toBeUndefined()
    expect(quote.evidence.explanation).toContain('formula unavailable')
  })

  test('model mapping credit cost override bypasses catalog', () => {
    const info: SupplierPriceInfo = {
      quotaType: 1,
      modelPrice: 0.014,
      source: 'remote-pricing',
    }
    const quote = engine.quote({ modelId: 'dall-e-3', numImages: 1, mappingCreditCostPerImage: 0.5 }, info)
    expect(quote.creditsPerImage).toBe(0.5)
    expect(quote.kind).toBe('catalog-quote')
  })

  test('policy override takes precedence over mapping', () => {
    const overrideEngine = new PricingEngine({ ...policy, overrideCreditsPerImage: { 'dall-e-3': 0.3 } })
    const quote = overrideEngine.quote({ modelId: 'dall-e-3', numImages: 1, mappingCreditCostPerImage: 0.5 })
    expect(quote.creditsPerImage).toBe(0.3)
  })

  test('fallback to default when no catalog pricing', () => {
    const quote = engine.quote({ modelId: 'unknown-model', numImages: 1 })
    expect(quote.fallback).toBe(true)
    expect(quote.kind).toBe('fallback')
    expect(quote.creditsPerImage).toBe(1)
  })

  test('throws when no pricing and fallback disabled', () => {
    const strict = new PricingEngine({ ...policy, fallbackToDefault: false })
    expect(() => strict.quote({ modelId: 'unknown-model', numImages: 1 })).toThrow(PricingNotAvailableError)
  })
})
