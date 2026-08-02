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
    const config = { modelMappings: [] } as unknown as Config
    const result = migrateConfig(config)
    expect(result.actions).toContain('modelMappings empty; explicit configuration required')
    expect(result.migrated).toBe(false)
  })

  test('migrates activeSupplier yunwu → newapi', () => {
    const config = { activeSupplier: 'yunwu', modelMappings: [] } as unknown as Config
    const result = migrateConfig(config)
    expect(result.config.activeSupplier).toBe('newapi')
    expect(result.migrated).toBe(true)
    expect(result.actions).toContain('migrated activeSupplier yunwu → newapi')
  })

  test('migrates activeSupplier gptgod → newapi', () => {
    const config = { activeSupplier: 'gptgod', modelMappings: [] } as unknown as Config
    const result = migrateConfig(config)
    expect(result.config.activeSupplier).toBe('newapi')
    expect(result.migrated).toBe(true)
    expect(result.actions).toContain('migrated activeSupplier gptgod → newapi')
  })

  test('leaves activeSupplier newapi unchanged', () => {
    const config = { activeSupplier: 'newapi', modelMappings: [] } as unknown as Config
    const result = migrateConfig(config)
    expect(result.config.activeSupplier).toBe('newapi')
    expect(result.migrated).toBe(false)
    expect(result.actions).not.toContain('migrated activeSupplier newapi → newapi')
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
