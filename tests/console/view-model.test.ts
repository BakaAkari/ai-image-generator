import { describe, expect, test } from 'vitest'
import { buildConsoleState } from '../../src/console/view-model.js'
import type { Config } from '../../src/shared/config.js'

const config = {
  activeSupplier: 'yunwu',
  creditExchangeRate: 1000,
  costMarkup: 1.3,
  modelMappings: [
    { suffix: 'fixed', modelId: 'per-call', chargePolicy: { type: 'fixed', creditsPerImage: 3 } },
    { suffix: 'token', modelId: 'per-token', chargePolicy: { type: 'cost-plus', acceptEstimated: false } },
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
}

describe('buildConsoleState', () => {
  test('fixed operational price is distinct from supplier cost', () => {
    const state = buildConsoleState(config, catalog as any, null)
    const row = state.catalog!.models.find(m => m.id === 'per-call')!
    expect(row.catalogPrice.label).toBe('$0.0100/次')
    expect(row.chargePolicy.label).toBe('固定 3 积分/张')
    expect(row.chargePolicy.source).toBe('operational-fixed')
  })

  test('token catalog quote without formula has no numeric per-image quote', () => {
    const state = buildConsoleState(config, catalog as any, null)
    const row = state.catalog!.models.find(m => m.id === 'per-token')!
    expect(row.catalogPrice.label).toContain('token')
    expect(row.costQuote.amountUsdPerImage).toBeUndefined()
    expect(row.costQuote.creditsPerImage).toBeUndefined()
    expect(row.costQuote.chargeable).toBe(false)
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
})
