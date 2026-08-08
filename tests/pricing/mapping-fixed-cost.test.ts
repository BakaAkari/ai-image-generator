import { describe, expect, test } from 'vitest'

import { resolveMappingFixedCost } from '../../src/shared/billing.js'
import type { ModelMappingConfig } from '../../src/shared/types.js'

describe('resolveMappingFixedCost（simple 固定积分结算短路核心）', () => {
  test('无映射 → null', () => {
    expect(resolveMappingFixedCost(undefined)).toBeNull()
    expect(resolveMappingFixedCost(null)).toBeNull()
  })

  test('simple 模式 creditCostPerImage 正数 → 返回该值', () => {
    const m = { suffix: 'gpt', modelId: 'g', creditCostPerImage: 5 } as ModelMappingConfig
    expect(resolveMappingFixedCost(m, 'simple')).toBe(5)
  })

  test('simple 模式 creditCostPerImage 为 0 / 负 / NaN / undefined → 不返回', () => {
    for (const v of [0, -1, NaN, undefined]) {
      expect(resolveMappingFixedCost({ suffix: 'g', modelId: 'g', creditCostPerImage: v } as ModelMappingConfig, 'simple')).toBeNull()
    }
  })

  test('simple 模式但无映射 → null（不误伤）', () => {
    expect(resolveMappingFixedCost(undefined, 'simple')).toBeNull()
  })

  test('auto 模式永远返回 null（即使有 creditCostPerImage），走公式链', () => {
    const m = { suffix: 'gpt', modelId: 'g', creditCostPerImage: 5 } as ModelMappingConfig
    expect(resolveMappingFixedCost(m, 'auto')).toBeNull()
  })

  test('未传 configMode（旧配置/undefined）→ 按 simple 处理', () => {
    const m = { suffix: 'gpt', modelId: 'g', creditCostPerImage: 5 } as ModelMappingConfig
    expect(resolveMappingFixedCost(m)).toBe(5)
  })

  test('billingPolicy（死字段）不参与结算短路', () => {
    const m = { suffix: 'g', modelId: 'g', billingPolicy: { type: 'fixed', creditsPerImage: 99 } } as unknown as ModelMappingConfig
    expect(resolveMappingFixedCost(m, 'simple')).toBeNull()
  })
})
