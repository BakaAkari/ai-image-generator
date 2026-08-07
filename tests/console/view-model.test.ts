import { describe, expect, test } from 'vitest'
import { buildConsoleState, resolveMappingGroupRatio } from '../../src/console/view-model.js'
import type { Config } from '../../src/shared/config.js'

const config = {
  activeSupplier: 'newapi',
  creditsPerCny: 10,
  pricingMarkupPercent: 30,
  modelMappings: [
    { suffix: 'fixed', modelId: 'per-call' },
    { suffix: 'token', modelId: 'per-token' },
    { suffix: 'vip-fixed', modelId: 'per-call', ratioOverride: 2.4 },
  ],
} as unknown as Config

const catalog = {
  supplier: 'newapi' as const,
  fetchedAt: 1000,
  models: [
    { id: 'per-call', modes: ['text-to-image'], routes: [{ id: 'openai:text-to-image', protocol: 'openai', capability: 'text-to-image' }], pricing: { type: 'per-call', pricePerCall: 0.01 }, source: 'remote-pricing' },
    { id: 'per-token', modes: ['text-to-image'], routes: [{ id: 'openai:text-to-image', protocol: 'openai', capability: 'text-to-image' }], pricing: { type: 'per-token', tokenRatio: 1 }, source: 'remote-pricing' },
  ],
  unsupportedModels: [
    { id: 'recognize-only', unsupportedReasons: ['image recognition endpoint'] },
  ],
}

describe('buildConsoleState', () => {
  test('renders yunwu cost column only (no catalogPrice / costQuote / chargePolicy / catalogEstimate)', () => {
    const state = buildConsoleState(config, catalog as any, null)
    const row = state.catalog!.models.find(m => m.id === 'per-call')!
    expect((row as any).catalogPrice).toBeUndefined()
    expect(row.yunwuCost.type).toBe('per-call')
    // 0.01 USD × 1 × 6.76 = 0.0676 → rounded 0.07
    expect(row.yunwuCost.label).toBe('¥0.07/张')
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

  test('yunwu cost applies mapping ratioOverride > 1', () => {
    const state = buildConsoleState(config, catalog as any, null, [
      { suffix: 'vip-fixed', modelId: 'per-call', ratioOverride: 2.4 },
    ])
    const row = state.catalog!.models.find(m => m.id === 'per-call')!
    expect(row.yunwuCost.label).toContain('×2.4')
    expect(row.yunwuCost.label.startsWith('¥')).toBe(true)
  })

  test('unsupported models are separated and never selectable', () => {
    const state = buildConsoleState(config, catalog as any, null)
    expect(state.catalog!.selectableModels.map(m => m.id)).not.toContain('recognize-only')
    expect(state.catalog!.unsupportedModels[0]).toMatchObject({ id: 'recognize-only', selectable: false })
  })

  test('only newapi is marked maintained', () => {
    const state = buildConsoleState(config, catalog as any, null)
    expect(state.suppliers.find(s => s.id === 'newapi')?.status).toBe('maintained')
    expect(state.suppliers.filter(s => s.id !== 'newapi').every(s => s.status === 'unsupported')).toBe(true)
  })

  test('model row carries its mapping groupRatio', () => {
    const state = buildConsoleState(config, catalog as any, null)
    const row = state.catalog!.models.find(m => m.id === 'per-call')!
    expect(row.groupRatio).toBe(1)
  })
})

describe('resolveMappingGroupRatio (now reads ratioOverride)', () => {
  test('returns mapping ratioOverride when positive finite', () => {
    expect(resolveMappingGroupRatio({ suffix: 'x', modelId: 'm', ratioOverride: 3.6 })).toBe(3.6)
  })

  test('falls back to 1 when ratioOverride missing', () => {
    expect(resolveMappingGroupRatio({ suffix: 'x', modelId: 'm' } as any)).toBe(1)
  })

  test('falls back to 1 for invalid ratioOverride values', () => {
    expect(resolveMappingGroupRatio({ suffix: 'x', modelId: 'm', ratioOverride: 0 } as any)).toBe(1)
    expect(resolveMappingGroupRatio({ suffix: 'x', modelId: 'm', ratioOverride: -1 } as any)).toBe(1)
    expect(resolveMappingGroupRatio({ suffix: 'x', modelId: 'm', ratioOverride: Number.NaN } as any)).toBe(1)
  })

  test('ignores legacy groupRatio (deprecated field, cleared by migration)', () => {
    expect(resolveMappingGroupRatio({ suffix: 'x', modelId: 'm', groupRatio: 3.6 } as any)).toBe(1)
  })
})
