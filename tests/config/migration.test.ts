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

  test('removes legacy global provider', () => {
    const config = { provider: 'openai-compatible' } as unknown as Config
    const result = migrateConfig(config)
    expect(result.migrated).toBe(true)
    expect(result.config).not.toHaveProperty('provider')
  })

  test('reports empty mappings', () => {
    const config = { modelMappings: [] } as unknown as Config
    const result = migrateConfig(config)
    expect(result.actions).toContain('modelMappings empty; default models will be derived from catalog at runtime')
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
