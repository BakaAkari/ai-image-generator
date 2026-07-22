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


  test('legacy explicit creditCostPerImage migrates to a fixed charge policy', () => {
    const config = {
      modelMappings: [{ suffix: 'gpt', modelId: 'gpt-image-2', creditCostPerImage: 0.3 }],
    } as unknown as Config
    const result = migrateConfig(config)
    expect(result.config.modelMappings![0]).toMatchObject({
      chargePolicy: { type: 'fixed', creditsPerImage: 0.3 },
    })
  })

  test('legacy mapping with catalog quote migrates to cost-plus and rejects estimates', () => {
    const config = {
      modelMappings: [{ suffix: 'gpt', modelId: 'gpt-image-2' }],
    } as unknown as Config
    const result = migrateConfig(config, modelId => modelId === 'gpt-image-2' ? 'catalog-quote' : 'unknown')
    expect(result.config.modelMappings![0]).toMatchObject({
      chargePolicy: { type: 'cost-plus', acceptEstimated: false },
    })
  })

  test('legacy mapping without a usable catalog quote migrates disabled', () => {
    const config = {
      modelMappings: [{ suffix: 'x', modelId: 'unknown-model' }],
    } as unknown as Config
    const result = migrateConfig(config, () => 'unknown')
    expect(result.config.modelMappings![0]).toMatchObject({
      chargePolicy: { type: 'disabled', reason: 'pricing unavailable' },
    })
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
  })
})

describe('sanitizeModelMapping', () => {
  test('keeps only allowed fields', () => {
    const m = sanitizeModelMapping({
      suffix: 'gpt', modelId: 'gpt-image-2', supplier: 'openai-compatible', protocol: 'openai', restricted: false, creditCostPerImage: 0.5,
    } as any)
    expect(m).toEqual({ suffix: 'gpt', modelId: 'gpt-image-2', restricted: false, chargePolicy: undefined, creditCostPerImage: 0.5 })
  })
})
