import { describe, test, expect } from 'vitest'
import { migrateConfig, sanitizeModelMapping } from '../../src/config/migration.js'
import type { Config } from '../../src/shared/config.js'

describe('migrateConfig', () => {
  test('removes legacy supplier/protocol/provider from mappings', () => {
    const config = {
      modelMappings: [
        { suffix: 'gem', modelId: 'gemini-3-pro-image-preview', supplier: 'gemini-official', protocol: 'gemini', restricted: false },
      ],
    } as unknown as Config
    const result = migrateConfig(config)
    expect(result.migrated).toBe(true)
    expect(result.config.modelMappings![0]).not.toHaveProperty('supplier')
    expect(result.config.modelMappings![0]).not.toHaveProperty('protocol')
    expect(result.config.modelMappings![0]).toHaveProperty('modelId')
    expect(result.actions).toContain('removed legacy supplier from mapping')
  })

  test('legacy cost-plus and global markup fields migrate cleanly', () => {
    const config = {
      creditExchangeRate: 1000,
      costMarkup: 1.3,
      modelMappings: [{ suffix: 'x', modelId: 'unknown-model' }],
    } as unknown as Config
    const result = migrateConfig(config)
    expect(result.config.pricingMarkupPercent).toBe(30)
    expect(result.config).not.toHaveProperty('costMarkup')
    expect(result.config).not.toHaveProperty('creditExchangeRate')
  })

  test('removes legacy global provider', () => {
    const config = { provider: 'openai-compatible' } as unknown as Config
    const result = migrateConfig(config)
    expect(result.migrated).toBe(true)
    expect(result.config).not.toHaveProperty('provider')
  })

  test('reports empty mappings', () => {
    const config = { modelMappings: [], usdToRmb: 6.76 } as unknown as Config
    const result = migrateConfig(config)
    expect(result.actions).toContain('modelMappings empty; explicit configuration required')
    // 已有 usdToRmb 且无其他旧字段：整体 migrated=false
    expect(result.migrated).toBe(false)
  })

  test('migrates activeSupplier yunwu → newapi', () => {
    const config = { activeSupplier: 'yunwu', modelMappings: [], usdToRmb: 6.76 } as unknown as Config
    const result = migrateConfig(config)
    expect(result.config.activeSupplier).toBe('newapi')
    expect(result.migrated).toBe(true)
    expect(result.actions).toContain('migrated activeSupplier yunwu → newapi')
  })

  test('migrates activeSupplier gptgod → newapi', () => {
    const config = { activeSupplier: 'gptgod', modelMappings: [], usdToRmb: 6.76 } as unknown as Config
    const result = migrateConfig(config)
    expect(result.config.activeSupplier).toBe('newapi')
    expect(result.migrated).toBe(true)
    expect(result.actions).toContain('migrated activeSupplier gptgod → newapi')
  })

  test('leaves activeSupplier newapi unchanged (usdToRmb already present)', () => {
    const config = { activeSupplier: 'newapi', modelMappings: [], usdToRmb: 6.76 } as unknown as Config
    const result = migrateConfig(config)
    expect(result.config.activeSupplier).toBe('newapi')
    expect(result.migrated).toBe(false)
    expect(result.actions).not.toContain('migrated activeSupplier newapi → newapi')
  })

  test('strips legacy mapping.groupRatio (deprecated), keeps ratioOverride intact', () => {
    const config = {
      modelMappings: [
        { suffix: 'mj', modelId: 'mj_imagine', groupRatio: 6, ratioOverride: 2.5 },
        { suffix: 'gpt', modelId: 'gpt-image-2', groupRatio: 1 },
        { suffix: 'clean', modelId: 'clean-model' },
      ],
    } as unknown as Config
    const result = migrateConfig(config)
    expect(result.migrated).toBe(true)
    for (const mapping of result.config.modelMappings!) {
      expect(mapping).not.toHaveProperty('groupRatio')
    }
    // ratioOverride 未被触碰
    expect((result.config.modelMappings![0] as any).ratioOverride).toBe(2.5)
    expect((result.config.modelMappings![1] as any).ratioOverride).toBeUndefined()
    expect(result.actions.some(a => a.startsWith('removed legacy mapping groupRatio'))).toBe(true)
  })

  test('legacy yunwuGroupRatio migrates through mapping.groupRatio then cleans up', () => {
    const config = {
      yunwuGroupRatio: 6,
      modelMappings: [{ suffix: 'x', modelId: 'm' }],
      usdToRmb: 6.76,
    } as unknown as Config
    const result = migrateConfig(config)
    // 旧全局 → mapping.groupRatio → 后被清理，最终 mapping 无 groupRatio 也无 ratioOverride
    expect(result.config).not.toHaveProperty('yunwuGroupRatio')
    expect(result.config.modelMappings![0]).not.toHaveProperty('groupRatio')
    expect((result.config.modelMappings![0] as any).ratioOverride).toBeUndefined()
  })
})

describe('migrateConfig quotaPerUnit legacy default (billing unit fix)', () => {
  test('quotaPerUnit=5000 (legacy unit-misread default) → 500000', () => {
    const config = { quotaPerUnit: 5000, modelMappings: [] } as unknown as Config
    const result = migrateConfig(config)
    expect(result.migrated).toBe(true)
    expect(result.config.quotaPerUnit).toBe(500000)
    expect(result.actions).toContain('migrated quotaPerUnit 5000 → 500000 (legacy unit-misread default corrected)')
  })

  test('quotaPerUnit=500000 (correct value) is left untouched', () => {
    const config = { quotaPerUnit: 500000, modelMappings: [] } as unknown as Config
    const result = migrateConfig(config)
    expect(result.config.quotaPerUnit).toBe(500000)
    expect(result.actions.some(a => a.includes('quotaPerUnit 5000'))).toBe(false)
  })

  test('custom non-standard quotaPerUnit (e.g. self-hosted 1000000) is preserved', () => {
    const config = { quotaPerUnit: 1000000, usdToRmb: 6.76, modelMappings: [] as never[] } as unknown as Config
    const result = migrateConfig(config)
    expect(result.config.quotaPerUnit).toBe(1000000)
    expect(result.actions.some(a => a.includes('quotaPerUnit'))).toBe(false)
  })
})

describe('migrateConfig usdToRmb rename (1.1.2)', () => {
  test('supplierCreditToRmb=0.5 (yunwu residue) → usdToRmb=6.76 (corrected default)', () => {
    const config = { supplierCreditToRmb: 0.5, modelMappings: [] } as unknown as Config
    const result = migrateConfig(config)
    expect(result.migrated).toBe(true)
    expect(result.config.usdToRmb).toBe(6.76)
    expect(result.config).not.toHaveProperty('supplierCreditToRmb')
    expect(result.actions.some(a => a.includes('usdToRmb 6.76'))).toBe(true)
    expect(result.actions).toContain('removed legacy supplierCreditToRmb')
  })

  test('missing supplierCreditToRmb → usdToRmb=6.76 default', () => {
    const config = { modelMappings: [] } as unknown as Config
    const result = migrateConfig(config)
    expect(result.migrated).toBe(true)
    expect(result.config.usdToRmb).toBe(6.76)
    expect(result.actions.some(a => a.includes('default corrected'))).toBe(true)
  })

  test('custom supplierCreditToRmb (e.g. 0.8) preserved into usdToRmb', () => {
    const config = { supplierCreditToRmb: 0.8, modelMappings: [] } as unknown as Config
    const result = migrateConfig(config)
    expect(result.migrated).toBe(true)
    expect(result.config.usdToRmb).toBe(0.8)
    expect(result.config).not.toHaveProperty('supplierCreditToRmb')
    expect(result.actions.some(a => a.includes('custom value preserved'))).toBe(true)
  })

  test('already-set usdToRmb is respected (only stale supplierCreditToRmb is dropped)', () => {
    const config = { usdToRmb: 7, supplierCreditToRmb: 0.5, modelMappings: [] } as unknown as Config
    const result = migrateConfig(config)
    expect(result.migrated).toBe(true)
    expect(result.config.usdToRmb).toBe(7)
    expect(result.config).not.toHaveProperty('supplierCreditToRmb')
  })

  test('invalid supplierCreditToRmb (0/NaN/negative) → usdToRmb=6.76 default', () => {
    for (const legacy of [0, Number.NaN, -1]) {
      const config = { supplierCreditToRmb: legacy, modelMappings: [] } as unknown as Config
      const result = migrateConfig(config)
      expect(result.config.usdToRmb).toBe(6.76)
    }
  })
})

describe('sanitizeModelMapping', () => {
  test('keeps only allowed fields', () => {
    const m = sanitizeModelMapping({
      suffix: 'gpt', modelId: 'gpt-image-2', supplier: 'openai-compatible', protocol: 'openai', restricted: false, creditCostPerImage: 0.5,
    } as any)
    expect(m).toEqual({ suffix: 'gpt', modelId: 'gpt-image-2', restricted: false, creditCostPerImage: 0.5 })
  })
})
