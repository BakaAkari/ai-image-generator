import { describe, expect, test } from 'vitest'
import { calculateGenerationCost, computePostGenerationCost, tokensToSupplierCredits } from '../../src/shared/billing.js'
import type { Config } from '../../src/shared/config.js'

const config = {
  creditsPerCny: 10,
  pricingMarkupPercent: 30,
  yunwuGroupRatio: 1,
  modelMappings: [{ suffix: 'x', modelId: 'm' }],
} as unknown as Config

describe('legacy billing bridge (deprecated, always returns reservation)', () => {
  test('returns generous reservation when no model mapping', () => {
    const cost = calculateGenerationCost({ numImages: 1, config })
    expect(cost.creditCostPerImage).toBe(200)
    expect(cost.totalCredits).toBe(200)
    expect(cost.costSource).toBe('post-generation')
  })

  test('returns generous reservation for 2 images', () => {
    const cost = calculateGenerationCost({
      numImages: 2,
      config,
      modelMapping: { suffix: 'x', modelId: 'm' } as any,
    })
    expect(cost.creditCostPerImage).toBe(200)
    expect(cost.totalCredits).toBe(400)
    expect(cost.modelSuffix).toBe('x')
  })

  test('returns generous reservation regardless of config params', () => {
    const changed = { ...config, creditsPerCny: 999, pricingMarkupPercent: 999 } as Config
    const cost = calculateGenerationCost({ numImages: 3, config: changed })
    expect(cost.totalCredits).toBe(600)
  })
})

describe('post-generation pricing', () => {
  test('tokensToSupplierCredits computes correctly', () => {
    expect(tokensToSupplierCredits(500000)).toBe(1)
    expect(tokensToSupplierCredits(1000000)).toBe(2)
    expect(tokensToSupplierCredits(250000)).toBe(0.5)
    expect(tokensToSupplierCredits(0)).toBe(0)
    expect(tokensToSupplierCredits(-100)).toBe(0)
  })

  test('computePostGenerationCost with default pricing config', () => {
    // 1 supplier credit × 0.5 × 10 credits/cny × 1.3 = 6.5
    const cost = computePostGenerationCost(1, { creditsPerCny: 10, pricingMarkupPercent: 30 })
    expect(cost).toBe(6.5)
  })

  test('computePostGenerationCost with different markup', () => {
    // 1 supplier credit × 0.5 × 10 × 1.0 = 5.0
    const cost = computePostGenerationCost(1, { creditsPerCny: 10, pricingMarkupPercent: 0 })
    expect(cost).toBe(5)
  })

  test('computePostGenerationCost with different creditsPerCny', () => {
    // 1 supplier credit × 0.5 × 20 × 1.3 = 13
    const cost = computePostGenerationCost(1, { creditsPerCny: 20, pricingMarkupPercent: 30 })
    expect(cost).toBe(13)
  })

  test('computePostGenerationCost returns 0 for invalid inputs', () => {
    expect(computePostGenerationCost(0, { creditsPerCny: 10, pricingMarkupPercent: 30 })).toBe(0)
    expect(computePostGenerationCost(-1, { creditsPerCny: 10, pricingMarkupPercent: 30 })).toBe(0)
  })
})
