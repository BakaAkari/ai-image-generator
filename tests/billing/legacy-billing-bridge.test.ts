import { describe, expect, test } from 'vitest'
import { calculateGenerationCost } from '../../src/shared/billing.js'
import type { Config } from '../../src/shared/config.js'

const config = { creditExchangeRate: 1000, costMarkup: 1.3, defaultCreditCostPerImage: 99 } as Config

describe('legacy billing bridge fails closed', () => {
  test('missing model mapping does not use global default price', () => {
    expect(() => calculateGenerationCost({ numImages: 1, config })).toThrow('未配置模型收费策略')
  })

  test('fixed charge policy produces an explicit charge', () => {
    const cost = calculateGenerationCost({
      numImages: 2,
      config,
      modelMapping: { suffix: 'x', modelId: 'm', chargePolicy: { type: 'fixed', creditsPerImage: 0.3 } },
    })
    expect(cost.totalCredits).toBe(0.6)
    expect(cost.costSource).toBe('model-fixed')
  })

  test('disabled policy rejects generation', () => {
    expect(() => calculateGenerationCost({
      numImages: 1,
      config,
      modelMapping: { suffix: 'x', modelId: 'm', chargePolicy: { type: 'disabled', reason: 'pricing unavailable' } },
    })).toThrow('pricing unavailable')
  })

  test('per-token catalog pricing without a formula is not charged', () => {
    expect(() => calculateGenerationCost({
      numImages: 1,
      config,
      modelMapping: { suffix: 'x', modelId: 'm', chargePolicy: { type: 'cost-plus', acceptEstimated: false } },
      catalogPricingLookup: () => ({ type: 'per-token', tokenRatio: 1 }),
    })).toThrow('无法计算')
  })
})
