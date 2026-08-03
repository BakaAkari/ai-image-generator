import { describe, expect, test } from 'vitest'
import {
  computeActualSupplierCredits,
  computeUpperBoundSupplierCredits,
  resolveUpperBoundRatio,
} from '../../src/shared/billing.js'
import type { CatalogModelForPricing } from '../../src/shared/billing.js'

const catalogModels: CatalogModelForPricing[] = [
  {
    id: 'doubao-seedream-3-0-t2i-250415',
    pricing: {
      type: 'per-call',
      pricePerCall: 0.1,
      enableGroups: ['Doubao-1', 'Doubao-2', 'Doubao-3', '测试'],
    },
  },
  {
    id: 'mj_imagine',
    pricing: {
      type: 'per-call',
      pricePerCall: 0.3,
      enableGroups: ['MJ-1', 'MJ-2'],
    },
  },
  {
    id: 'gpt-image-2',
    pricing: {
      type: 'per-token',
      tokenRatio: 2.5,
      completionRatio: 6,
      officialPriceOutput: 100,
      enableGroups: ['Gpt-Image-2'],
    },
  },
  {
    id: 'no-pricing-model',
    pricing: { type: 'unknown' },
  },
]

const groupRatioMap: Record<string, number> = {
  'Doubao-1': 0.07353,
  'Doubao-2': 0.1103,
  'Doubao-3': 0.22059,
  测试: 0.73529411765,
  'MJ-1': 0.04412,
  'MJ-2': 0.07353,
  'Gpt-Image-2': 0.09192,
  default: 0.07353,
}

describe('resolveUpperBoundRatio', () => {
  test('returns max ratio among enable_groups', () => {
    expect(resolveUpperBoundRatio(['Doubao-1', 'Doubao-2', 'Doubao-3'], groupRatioMap)).toBeCloseTo(0.22059, 5)
  })

  test('falls back when no groups match the map', () => {
    expect(resolveUpperBoundRatio(['Unknown-Group'], groupRatioMap, 1)).toBe(1)
    expect(resolveUpperBoundRatio(['Unknown-Group'], groupRatioMap, 2.5)).toBe(2.5)
  })

  test('returns fallback when enableGroups is empty or map missing', () => {
    expect(resolveUpperBoundRatio(undefined, groupRatioMap, 1)).toBe(1)
    expect(resolveUpperBoundRatio(['Doubao-1'], undefined, 1)).toBe(1)
  })
})

describe('computeUpperBoundSupplierCredits', () => {
  test('per-call model uses pricePerCall × max group ratio', () => {
    const credits = computeUpperBoundSupplierCredits('doubao-seedream-3-0-t2i-250415', catalogModels, groupRatioMap)
    // 0.1 × 0.73529411765 (测试组最大)
    expect(credits).toBeCloseTo(0.1 * 0.73529411765, 6)
  })

  test('mj_imagine upper bound uses max(MJ-1, MJ-2)', () => {
    const credits = computeUpperBoundSupplierCredits('mj_imagine', catalogModels, groupRatioMap)
    expect(credits).toBeCloseTo(0.3 * 0.07353, 6)
  })

  test('per-token model uses upper-bound estimate with completionRatio penalty', () => {
    const credits = computeUpperBoundSupplierCredits('gpt-image-2', catalogModels, groupRatioMap)
    // DEFAULT_TOKEN_ESTIMATE × (1+completionRatio) × tokenRatio / 500000 × max(group ratio)
    expect(credits).toBeCloseTo(15000 * (1 + 6) * 2.5 / 500000 * 0.09192, 8)
  })

  test('unknown pricing falls back to highest known per-call price × ratio', () => {
    const credits = computeUpperBoundSupplierCredits('no-pricing-model', catalogModels, groupRatioMap)
    // max(0.1, 0.3) = 0.3 × fallback 1
    expect(credits).toBeCloseTo(0.3, 6)
  })

  test('falls back to fallbackRatio when groupRatioMap missing', () => {
    const credits = computeUpperBoundSupplierCredits('mj_imagine', catalogModels, undefined, 2)
    expect(credits).toBeCloseTo(0.3 * 2, 6)
  })
})

describe('computeActualSupplierCredits', () => {
  test('per-call model uses actual routing group ratio', () => {
    const credits = computeActualSupplierCredits('doubao-seedream-3-0-t2i-250415', null, catalogModels, 0.07353)
    expect(credits).toBeCloseTo(0.1 * 0.07353, 8)
  })

  test('actual ratio 1 (no routing info) equals plain pricePerCall', () => {
    const credits = computeActualSupplierCredits('mj_imagine', null, catalogModels, 1)
    expect(credits).toBeCloseTo(0.3, 6)
  })

  test('per-token model uses totalTokens × completionRatio with actual ratio', () => {
    const credits = computeActualSupplierCredits('gpt-image-2', 30000, catalogModels, 0.09192)
    // 30000 × completionRatio(6) × tokenRatio(2.5) / 500000 × 0.09192
    expect(credits).toBeCloseTo(30000 * 6 * 2.5 / 500000 * 0.09192, 8)
  })

  test('per-token model uses input/output split when available', () => {
    // input=100, output=400 → effective = 100 + 400×6 = 2500
    const credits = computeActualSupplierCredits('gpt-image-2', 500, catalogModels, 0.09192, 100, 400)
    expect(credits).toBeCloseTo((100 + 400 * 6) * 2.5 / 500000 * 0.09192, 8)
  })

  test('upper bound is always >= actual for the same model', () => {
    const upper = computeUpperBoundSupplierCredits('doubao-seedream-3-0-t2i-250415', catalogModels, groupRatioMap)
    const actual = computeActualSupplierCredits('doubao-seedream-3-0-t2i-250415', null, catalogModels, 0.07353)
    expect(upper).toBeGreaterThanOrEqual(actual)
  })
})
