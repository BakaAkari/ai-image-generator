import { describe, expect, test } from 'vitest'
import { buildConsoleState, resolveYunwuGroupRatio } from '../../src/console/view-model.js'
import type { Config } from '../../src/shared/config.js'

const config = {
  activeSupplier: 'yunwu',
  creditsPerCny: 10,
  pricingMarkupPercent: 30,
  yunwuGroupRatio: 1,
  modelMappings: [
    { suffix: 'fixed', modelId: 'per-call' },
    { suffix: 'token', modelId: 'per-token' },
  ],
} as unknown as Config

const catalog = {
  supplier: 'yunwu' as const,
  fetchedAt: 1000,
  models: [
    { id: 'per-call', modes: ['text-to-image'], routes: [{ id: 'openai:text-to-image', protocol: 'openai', capability: 'text-to-image' }], pricing: { type: 'per-call', pricePerCall: 0.01 }, source: 'remote-pricing' },
    { id: 'per-token', modes: ['text-to-image'], routes: [{ id: 'openai:text-to-image', protocol: 'openai', capability: 'text-to-image' }], pricing: { type: 'per-token', tokenRatio: 1 }, source: 'remote-pricing' },
  ],
  unsupportedModels: [
    { id: 'recognize-only', unsupportedReasons: ['image recognition endpoint'] },
  ],
  groupRatio: { default: 1, vip: 2.4 },
}

describe('buildConsoleState', () => {
  test('renders yunwu cost column only (no catalogPrice / costQuote / chargePolicy / catalogEstimate)', () => {
    const state = buildConsoleState(config, catalog as any, null)
    const row = state.catalog!.models.find(m => m.id === 'per-call')!
    expect((row as any).catalogPrice).toBeUndefined()
    expect(row.yunwuCost.type).toBe('per-call')
    expect(row.yunwuCost.label).toBe('¥0.01/张')
    expect((row as any).costQuote).toBeUndefined()
    expect((row as any).chargePolicy).toBeUndefined()
    expect((row as any).catalogEstimate).toBeUndefined()
  })

  test('token catalog quote without formula still renders "按量" hint', () => {
    const state = buildConsoleState(config, catalog as any, null)
    const row = state.catalog!.models.find(m => m.id === 'per-token')!
    expect(row.yunwuCost.type).toBe('per-token')
    expect(row.yunwuCost.label).toContain('按量')
  })

  test('yunwu cost applies group ratio > 1', () => {
    const cfg = { ...config, yunwuGroupRatio: 2.4 } as Config
    const state = buildConsoleState(cfg, catalog as any, null)
    const row = state.catalog!.models.find(m => m.id === 'per-call')!
    // 0.01 * 2.4 * 0.5 = 0.012 → rounded to ¥0.01
    expect(row.yunwuCost.label).toContain('×2.4')
    expect(row.yunwuCost.label.startsWith('¥')).toBe(true)
  })

  test('unsupported models are separated and never selectable', () => {
    const state = buildConsoleState(config, catalog as any, null)
    expect(state.catalog!.selectableModels.map(m => m.id)).not.toContain('recognize-only')
    expect(state.catalog!.unsupportedModels[0]).toMatchObject({ id: 'recognize-only', selectable: false })
  })

  test('only yunwu is marked maintained', () => {
    const state = buildConsoleState(config, catalog as any, null)
    expect(state.suppliers.find(s => s.id === 'yunwu')?.status).toBe('maintained')
    expect(state.suppliers.filter(s => s.id !== 'yunwu').every(s => s.status === 'unsupported')).toBe(true)
  })

  test('exposes catalog groupRatio to the client', () => {
    const state = buildConsoleState(config, catalog as any, null)
    expect(state.catalog!.groupRatio).toEqual({ default: 1, vip: 2.4 })
  })
})

describe('resolveYunwuGroupRatio (legacy string group → numeric ratio migration)', () => {
  test('prefers explicit yunwuGroupRatio when a positive finite number', () => {
    const ratio = resolveYunwuGroupRatio({ yunwuGroupRatio: 3.6 } as any, { default: 1, vip: 2 })
    expect(ratio).toBe(3.6)
  })

  test('maps legacy string yunwuGroup via catalog groupRatio when numeric field absent', () => {
    const ratio = resolveYunwuGroupRatio({ yunwuGroup: 'vip' } as any, { default: 1, vip: 2.4 })
    expect(ratio).toBe(2.4)
  })

  test('falls back to 1 when legacy name has no groupRatio mapping', () => {
    const ratio = resolveYunwuGroupRatio({ yunwuGroup: 'unknown-group' } as any, { default: 1 })
    expect(ratio).toBe(1)
  })

  test('falls back to 1 when groupRatio undefined', () => {
    const ratio = resolveYunwuGroupRatio({ yunwuGroup: 'vip' } as any, undefined)
    expect(ratio).toBe(1)
  })

  test('rejects zero, negative and non-finite numeric ratios (safe default 1)', () => {
    expect(resolveYunwuGroupRatio({ yunwuGroupRatio: 0 } as any)).toBe(1)
    expect(resolveYunwuGroupRatio({ yunwuGroupRatio: -1 } as any)).toBe(1)
    expect(resolveYunwuGroupRatio({ yunwuGroupRatio: Number.NaN } as any)).toBe(1)
  })
})

describe('buildConsoleState legacy yunwuGroup → yunwuGroupRatio migration (contract)', () => {
  const legacyCatalog = {
    supplier: 'yunwu' as const,
    fetchedAt: 1000,
    models: [
      { id: 'per-call', modes: ['text-to-image'], routes: [{ id: 'r', protocol: 'openai', capability: 'text-to-image' }], pricing: { type: 'per-call', pricePerCall: 0.01 }, source: 'remote-pricing' },
    ],
    unsupportedModels: [],
    groupRatio: { default: 1, vip: 2.4 },
  }

  test('writes effectiveRatio into returned config when yunwuGroupRatio is missing but legacy yunwuGroup maps in catalog', () => {
    const cfg = { yunwuGroup: 'vip', modelMappings: [], styles: [] } as unknown as Config
    const state = buildConsoleState(cfg, legacyCatalog as any, null)
    expect(state.config.yunwuGroupRatio).toBe(2.4)
  })

  test('writes effectiveRatio into returned config when yunwuGroupRatio is zero (invalid)', () => {
    const cfg = { yunwuGroup: 'vip', yunwuGroupRatio: 0, modelMappings: [], styles: [] } as unknown as Config
    const state = buildConsoleState(cfg, legacyCatalog as any, null)
    expect(state.config.yunwuGroupRatio).toBe(2.4)
  })

  test('leaves existing valid numeric yunwuGroupRatio untouched', () => {
    const cfg = { yunwuGroupRatio: 3.6, modelMappings: [], styles: [] } as unknown as Config
    const state = buildConsoleState(cfg, legacyCatalog as any, null)
    expect(state.config.yunwuGroupRatio).toBe(3.6)
  })

  test('falls back to 1 when legacy name has no mapping and numeric field is invalid', () => {
    const cfg = { yunwuGroup: 'no-such', yunwuGroupRatio: -1, modelMappings: [], styles: [] } as unknown as Config
    const state = buildConsoleState(cfg, legacyCatalog as any, null)
    expect(state.config.yunwuGroupRatio).toBe(1)
  })

  test('does not mutate the incoming config object', () => {
    const cfg = { yunwuGroup: 'vip', modelMappings: [], styles: [] } as unknown as Config
    const snapshot = JSON.parse(JSON.stringify(cfg))
    buildConsoleState(cfg, legacyCatalog as any, null)
    expect(cfg).toEqual(snapshot)
  })
})
