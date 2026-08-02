import { describe, expect, it } from 'vitest'

import { normalizeNewApiBilling, PLATFORM_CREDIT_TO_RMB, SUPPLIER_CREDIT_TO_RMB } from '../../src/catalog/billing-info.js'

describe('normalizeNewApiBilling naming and compat', () => {
  const baseSnapshot = {
    supplier: 'newapi' as const,
    fetchedAt: 1,
    keyScopeFingerprint: 'fp',
    endpoints: {
      models: { url: '', status: 200, fetchedAt: 1, success: true, data: { data: [] } },
      pricing: { url: '', status: 200, fetchedAt: 1, success: true, data: { data: [] } },
      status: { url: '', status: 200, fetchedAt: 1, success: true, data: {} as any },
      billing: {
        url: '', status: 200, fetchedAt: 1, success: true as const,
        data: { total_usage: 26397, soft_limit_usd: 5, hard_limit_usd: 20, token_name: 'k1' } as any,
      },
    },
  } as any

  it('exposes supplierCredits = total_usage / 500000 and keeps the legacy alias', () => {
    const info = normalizeNewApiBilling(baseSnapshot)
    expect(info.supplierCredits).toBeCloseTo(26397 / 500000, 8)
    expect(info.platformCredits).toBeCloseTo(26397 / 500000, 8)
  })

  it('populates totalUsageUsd with the SAME numeric value for backward compat readers', () => {
    const info = normalizeNewApiBilling(baseSnapshot)
    expect(info.totalUsageUsd).toBe(info.platformCredits)
  })

  it('exports the fixed 0.5 newapi credit→RMB rate as a constant', () => {
    expect(PLATFORM_CREDIT_TO_RMB).toBe(0.5)
    expect(SUPPLIER_CREDIT_TO_RMB).toBe(0.5)
  })

  it('handles missing usage gracefully (null credits, null legacy alias)', () => {
    const snap = { ...baseSnapshot, endpoints: { ...baseSnapshot.endpoints, billing: { url: '', status: 500, fetchedAt: 1, success: false, error: 'x' } } } as any
    const info = normalizeNewApiBilling(snap)
    expect(info.supplierCredits).toBeNull()
    expect(info.platformCredits).toBeNull()
    expect(info.totalUsageUsd).toBeNull()
  })
})
