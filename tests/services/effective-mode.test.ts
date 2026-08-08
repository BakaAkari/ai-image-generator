import { describe, expect, test } from 'vitest'

import { hasSupplierCredential, resolveEffectiveMode } from '../../src/shared/effective-mode.js'
import { migrateConfig } from '../../src/config/migration.js'

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    configMode: 'auto',
    activeSupplier: 'newapi',
    providerSettings: {
      openaiCompatibleApiKey: 'sk-test',
      openaiCompatibleApiBase: 'https://api.openlux.ai/v1',
      gptOfficialApiKey: '',
      geminiOfficialApiKey: '',
      openaiCompatibleExtraHeaders: {},
    },
    modelMappings: [
      { suffix: 'gpt', modelId: 'gpt-image-2', restricted: false },
      { suffix: 'mj', modelId: 'mj_imagine', billingPolicy: { type: 'fixed', creditsPerImage: 5 } },
    ],
    ...overrides,
  }
}

describe('hasSupplierCredential', () => {
  test('newapi：有 key 视为已配置', () => {
    expect(hasSupplierCredential(baseConfig() as never)).toBe(true)
  })

  test('newapi：key 为空 / 空白视为未配置', () => {
    expect(hasSupplierCredential(baseConfig({ providerSettings: { openaiCompatibleApiKey: '' } }) as never)).toBe(false)
    expect(hasSupplierCredential(baseConfig({ providerSettings: { openaiCompatibleApiKey: '   ' } }) as never)).toBe(false)
    expect(hasSupplierCredential(baseConfig({ providerSettings: undefined }) as never)).toBe(false)
  })

  test('openai-official：读 gptOfficialApiKey', () => {
    const cfg = baseConfig({ activeSupplier: 'openai-official' })
    expect(hasSupplierCredential(cfg as never)).toBe(false)
    const cfg2 = baseConfig({
      activeSupplier: 'openai-official',
      providerSettings: { openaiCompatibleApiKey: '', openaiCompatibleApiBase: '', gptOfficialApiKey: 'sk-oa', geminiOfficialApiKey: '', openaiCompatibleExtraHeaders: {} },
    })
    expect(hasSupplierCredential(cfg2 as never)).toBe(true)
  })

  test('gemini-official：读 geminiOfficialApiKey', () => {
    const cfg = baseConfig({
      activeSupplier: 'gemini-official',
      providerSettings: { openaiCompatibleApiKey: '', openaiCompatibleApiBase: '', gptOfficialApiKey: '', geminiOfficialApiKey: 'AI-zzz', openaiCompatibleExtraHeaders: {} },
    })
    expect(hasSupplierCredential(cfg as never)).toBe(true)
  })
})

describe('resolveEffectiveMode', () => {
  test('意图 simple 恒 simple（即使有凭据）', () => {
    expect(resolveEffectiveMode(baseConfig({ configMode: 'simple' }) as never)).toEqual({ mode: 'simple' })
  })

  test('意图缺省（undefined）→ simple（默认值兜底）', () => {
    expect(resolveEffectiveMode(baseConfig({ configMode: undefined }) as never)).toEqual({ mode: 'simple' })
  })

  test('auto + 无凭据 → fallback simple(no-credential)', () => {
    const cfg = baseConfig({ providerSettings: { openaiCompatibleApiKey: '' } })
    expect(resolveEffectiveMode(cfg as never)).toEqual({ mode: 'simple', fallbackReason: 'no-credential' })
  })

  test('auto + 有凭据 + catalogOk → auto', () => {
    expect(resolveEffectiveMode(baseConfig() as never, true)).toEqual({ mode: 'auto' })
  })

  test('auto + 有凭据 + catalog 失败 → fallback simple(catalog-failed)', () => {
    expect(resolveEffectiveMode(baseConfig() as never, false)).toEqual({ mode: 'simple', fallbackReason: 'catalog-failed' })
  })

  test('catalogOk 缺省视为 true，不误 fallback', () => {
    expect(resolveEffectiveMode(baseConfig() as never)).toEqual({ mode: 'auto' })
  })
})

describe('migrateConfig: configMode manual → simple', () => {
  test('manual → simple', () => {
    const cfg = baseConfig({ configMode: 'manual' })
    const res = migrateConfig(cfg as never)
    expect(res.config.configMode).toBe('simple')
    expect(res.migrated).toBe(true)
    expect(res.actions.some(a => a.includes('manual → simple'))).toBe(true)
  })

  test('auto / simple 保持不变', () => {
    const auto = migrateConfig(baseConfig({ configMode: 'auto' }) as never)
    expect(auto.config.configMode).toBe('auto')
    const simple = migrateConfig(baseConfig({ configMode: 'simple' }) as never)
    expect(simple.config.configMode).toBe('simple')
  })

  test('simple 模式：无固定积分的映射补默认 1 积分/次；billingPolicy.fixed 值迁移到 creditCostPerImage 后删字段', () => {
    const cfg = baseConfig({
      configMode: 'simple',
      modelMappings: [
        { suffix: 'gpt', modelId: 'gpt-image-2' },
        { suffix: 'mj', modelId: 'mj_imagine', billingPolicy: { type: 'fixed', creditsPerImage: 5 } },
        { suffix: 'legacy', modelId: 'legacy-img', creditCostPerImage: 3 },
      ],
    })
    const res = migrateConfig(cfg as never)
    const mappings = res.config.modelMappings as Array<Record<string, any>>
    expect(mappings[0].creditCostPerImage).toBe(1)
    expect(mappings[0].billingPolicy).toBeUndefined()
    // 用户显式 billingPolicy.fixed=5 → 迁移到 creditCostPerImage，字段删除
    expect(mappings[1].creditCostPerImage).toBe(5)
    expect(mappings[1].billingPolicy).toBeUndefined()
    // 旧 creditCostPerImage 数字保留
    expect(mappings[2].creditCostPerImage).toBe(3)
  })

  test('auto 模式：不补默认积分，保留用户显式 billingPolicy（如 mj fixed 0.1）', () => {
    const cfg = baseConfig({
      configMode: 'auto',
      modelMappings: [
        { suffix: 'gpt', modelId: 'gpt-image-2' },
        { suffix: 'mj', modelId: 'mj_imagine', billingPolicy: { type: 'fixed', creditsPerImage: 5 } },
      ],
    })
    const res = migrateConfig(cfg as never)
    const mappings = res.config.modelMappings as Array<Record<string, any>>
    expect(mappings[0].creditCostPerImage).toBeUndefined()
    expect(mappings[0].billingPolicy).toBeUndefined()
    // auto 模式保留用户显式 billingPolicy（结算层不消费，但 config-autopilot 推导不覆盖它）
    expect(mappings[1].billingPolicy).toEqual({ type: 'fixed', creditsPerImage: 5 })
    expect(mappings[1].creditCostPerImage).toBeUndefined()
  })
})
