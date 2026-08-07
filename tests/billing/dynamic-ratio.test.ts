import { describe, expect, test } from 'vitest'
import {
  DEFAULT_PER_TOKEN_ESTIMATE,
  DEFAULT_QUOTA_PER_UNIT,
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

  test('per-token model uses defaults (perTokenEstimate=2000, quotaPerUnit=500000)', () => {
    const credits = computeUpperBoundSupplierCredits('gpt-image-2', catalogModels, groupRatioMap)
    // DEFAULT_PER_TOKEN_ESTIMATE × (1+completionRatio) × tokenRatio / DEFAULT_QUOTA_PER_UNIT × max(group ratio)
    expect(credits).toBeCloseTo(2000 * (1 + 6) * 2.5 / 500000 * 0.09192, 10)
  })

  test('per-token model honors opts.quotaPerUnit and opts.perTokenEstimate overrides', () => {
    const credits = computeUpperBoundSupplierCredits(
      'gpt-image-2', catalogModels, groupRatioMap, 1, undefined,
      { quotaPerUnit: 5000, perTokenEstimate: 15000 },
    )
    // 覆盖到自建站的非标 QuotaPerUnit=5000 + 更大估算基线，验证参数确实生效
    expect(credits).toBeCloseTo(15000 * 7 * 2.5 / 5000 * 0.09192, 8)
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

  test('ratioOverride bypasses enable_groups lookup', () => {
    // 显式 override 时必须直接使用 override，不走表
    const credits = computeUpperBoundSupplierCredits('mj_imagine', catalogModels, groupRatioMap, 1, 2.5)
    expect(credits).toBeCloseTo(0.3 * 2.5, 6)
  })

  test('ratioOverride is ignored when non-positive', () => {
    // 0 / NaN → 走正常表查询
    const zero = computeUpperBoundSupplierCredits('mj_imagine', catalogModels, groupRatioMap, 1, 0)
    expect(zero).toBeCloseTo(0.3 * 0.07353, 6)
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

  test('per-token model uses totalTokens × completionRatio with actual ratio (quotaPerUnit=500000)', () => {
    const credits = computeActualSupplierCredits('gpt-image-2', 30000, catalogModels, 0.09192)
    // 30000 × completionRatio(6) × tokenRatio(2.5) / 500000 × 0.09192
    expect(credits).toBeCloseTo(30000 * 6 * 2.5 / 500000 * 0.09192, 10)
  })

  test('per-token model uses input/output split when available (quotaPerUnit=500000)', () => {
    // input=100, output=400 → effective = 100 + 400×6 = 2500
    const credits = computeActualSupplierCredits('gpt-image-2', 500, catalogModels, 0.09192, 100, 400)
    expect(credits).toBeCloseTo((100 + 400 * 6) * 2.5 / 500000 * 0.09192, 10)
  })

  test('per-token model honors custom quotaPerUnit override', () => {
    const credits = computeActualSupplierCredits('gpt-image-2', 30000, catalogModels, 0.09192, undefined, undefined, 5000)
    expect(credits).toBeCloseTo(30000 * 6 * 2.5 / 5000 * 0.09192, 8)
  })

  test('upper bound is always >= actual for the same model', () => {
    const upper = computeUpperBoundSupplierCredits('doubao-seedream-3-0-t2i-250415', catalogModels, groupRatioMap)
    const actual = computeActualSupplierCredits('doubao-seedream-3-0-t2i-250415', null, catalogModels, 0.07353)
    expect(upper).toBeGreaterThanOrEqual(actual)
  })
})

/**
 * 门户「计费过程」的真实扣费公式（per-call）：真实美元 = model_price × group_ratio。
 * 铁证 2026-08-06：MJ $0.013236 = 0.3 × 0.04412、gemini $0.012169 = 0.1655 × 0.07353。
 * per-call 模型的表值即真，不需要 quota 除数。
 */
describe('per-call real-world extractions (2026-08-06)', () => {
  const cases: Array<{ label: string; modelId: string; pricePerCall: number; ratio: number; expectedUsd: number }> = [
    { label: 'MJ mj_imagine × MJ-1 (0.3 × 0.04412)', modelId: 'mj_imagine', pricePerCall: 0.3, ratio: 0.04412, expectedUsd: 0.013236 },
    { label: 'gemini-fake (0.1655 × 0.07353)', modelId: 'gemini-per-call', pricePerCall: 0.1655, ratio: 0.07353, expectedUsd: 0.012169 },
  ]
  const modelsForCases: CatalogModelForPricing[] = cases.map(c => ({
    id: c.modelId,
    pricing: { type: 'per-call', pricePerCall: c.pricePerCall },
  }))
  for (const c of cases) {
    test(c.label, () => {
      const usd = computeActualSupplierCredits(c.modelId, null, modelsForCases, c.ratio)
      expect(usd).toBeCloseTo(c.expectedUsd, 6)
    })
  }
})
