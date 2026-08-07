import { describe, expect, test } from 'vitest'
import {
  DEFAULT_PER_TOKEN_ESTIMATE,
  DEFAULT_QUOTA_PER_UNIT,
  USD_TO_RMB,
  calculateGenerationCost,
  computePostGenerationCost,
  resolveSupplierCreditToRmb,
  resolveUsdToRmb,
  roundCreditsPrecise,
  tokensToSupplierCredits,
} from '../../src/shared/billing.js'
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
  test('exports defaults (USD_TO_RMB=6.76, quota=500000, perTokenEstimate=2000)', () => {
    expect(USD_TO_RMB).toBe(6.76)
    expect(DEFAULT_QUOTA_PER_UNIT).toBe(500000)
    expect(DEFAULT_PER_TOKEN_ESTIMATE).toBe(2000)
  })

  test('tokensToSupplierCredits uses default quotaPerUnit=500000', () => {
    // 500000 raw tokens ÷ 500000 = 1 USD
    expect(tokensToSupplierCredits(500000)).toBe(1)
    expect(tokensToSupplierCredits(1_000_000)).toBe(2)
    expect(tokensToSupplierCredits(250_000)).toBe(0.5)
    expect(tokensToSupplierCredits(0)).toBe(0)
    expect(tokensToSupplierCredits(-100)).toBe(0)
  })

  test('tokensToSupplierCredits honors custom quotaPerUnit override', () => {
    // 自建站的非标 QuotaPerUnit=5000：显式传入应反映
    expect(tokensToSupplierCredits(5000, 1, 5000)).toBe(1)
    expect(tokensToSupplierCredits(1000, 2, 5000)).toBe(0.4)
  })

  test('computePostGenerationCost with default pricing (usdToRmb=6.76)', () => {
    // 1 USD × 6.76 × 10 credits/cny × 1.3 = 87.88
    const cost = computePostGenerationCost(1, { creditsPerCny: 10, pricingMarkupPercent: 30 })
    expect(cost).toBeCloseTo(87.88, 2)
  })

  test('computePostGenerationCost with markup 0', () => {
    // 1 USD × 6.76 × 10 × 1.0 = 67.6
    const cost = computePostGenerationCost(1, { creditsPerCny: 10, pricingMarkupPercent: 0 })
    expect(cost).toBeCloseTo(67.6, 2)
  })

  test('computePostGenerationCost with different creditsPerCny', () => {
    // 1 USD × 6.76 × 20 × 1.3 = 175.76
    const cost = computePostGenerationCost(1, { creditsPerCny: 20, pricingMarkupPercent: 30 })
    expect(cost).toBeCloseTo(175.76, 2)
  })

  test('computePostGenerationCost returns 0 for invalid inputs', () => {
    expect(computePostGenerationCost(0, { creditsPerCny: 10, pricingMarkupPercent: 30 })).toBe(0)
    expect(computePostGenerationCost(-1, { creditsPerCny: 10, pricingMarkupPercent: 30 })).toBe(0)
  })

  test('computePostGenerationCost honors custom usdToRmb (preferred field)', () => {
    // 1 USD × 6.5 × 10 × 1.3 = 84.5
    const cost = computePostGenerationCost(1, { creditsPerCny: 10, pricingMarkupPercent: 30, usdToRmb: 6.5 })
    expect(cost).toBeCloseTo(84.5, 2)
  })

  test('computePostGenerationCost falls back to deprecated supplierCreditToRmb when usdToRmb missing', () => {
    // migration 窗口内可能同时残留旧字段；无 usdToRmb 时用 supplierCreditToRmb
    // 1 USD × 0.8 × 10 × 1.3 = 10.4
    const cost = computePostGenerationCost(1, { creditsPerCny: 10, pricingMarkupPercent: 30, supplierCreditToRmb: 0.8 })
    expect(cost).toBeCloseTo(10.4, 2)
  })

  test('computePostGenerationCost prefers usdToRmb over supplierCreditToRmb when both present', () => {
    // 1 USD × 7 × 10 × 1.3 = 91
    const cost = computePostGenerationCost(1, {
      creditsPerCny: 10, pricingMarkupPercent: 30, usdToRmb: 7, supplierCreditToRmb: 0.8,
    })
    expect(cost).toBeCloseTo(91, 2)
  })

  test('computePostGenerationCost with round:false keeps 4dp precision (per-token 微额)', () => {
    // 0.0004 USD × 6.76 × 10 × 1.3 = 0.0351 → 2dp roundCredits 保留 0.04；4dp 精确 0.0351
    const rounded = computePostGenerationCost(0.0004, { creditsPerCny: 10, pricingMarkupPercent: 30 })
    expect(rounded).toBeCloseTo(0.04, 2)
    const precise = computePostGenerationCost(0.0004, { creditsPerCny: 10, pricingMarkupPercent: 30 }, { round: false })
    expect(precise).toBeCloseTo(0.0004 * 6.76 * 10 * 1.3, 4)
    expect(precise).toBeGreaterThan(0)
  })
})

describe('roundCreditsPrecise', () => {
  test('rounds to 4 decimal places by default', () => {
    expect(roundCreditsPrecise(0.00123456)).toBe(0.0012)
    expect(roundCreditsPrecise(1.23456789)).toBe(1.2346)
  })

  test('honors custom dp', () => {
    expect(roundCreditsPrecise(0.123456, 2)).toBe(0.12)
    expect(roundCreditsPrecise(0.123456, 6)).toBe(0.123456)
  })

  test('clamps negative to 0, handles non-finite', () => {
    expect(roundCreditsPrecise(-1)).toBe(0)
    expect(roundCreditsPrecise(Number.NaN)).toBe(0)
    expect(roundCreditsPrecise(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('resolveUsdToRmb', () => {
  test('returns default 6.76 when undefined', () => {
    expect(resolveUsdToRmb(undefined)).toBe(6.76)
  })

  test('returns config value when valid', () => {
    expect(resolveUsdToRmb(6.5)).toBe(6.5)
  })

  test('falls back to default for non-positive or invalid values', () => {
    expect(resolveUsdToRmb(0)).toBe(6.76)
    expect(resolveUsdToRmb(-1)).toBe(6.76)
    expect(resolveUsdToRmb(Number.NaN)).toBe(6.76)
    expect(resolveUsdToRmb(Number.POSITIVE_INFINITY)).toBe(6.76)
  })

  test('deprecated resolveSupplierCreditToRmb alias delegates to resolveUsdToRmb', () => {
    expect(resolveSupplierCreditToRmb(6.5)).toBe(6.5)
    expect(resolveSupplierCreditToRmb(undefined)).toBe(6.76)
  })
})
