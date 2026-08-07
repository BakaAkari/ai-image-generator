import { describe, expect, it } from 'vitest'

import { normalizeNewApiBilling, PLATFORM_CREDIT_TO_RMB, SUPPLIER_CREDIT_TO_RMB, USD_TO_RMB } from '../../src/catalog/billing-info.js'

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
        data: { total_usage: 125, soft_limit_usd: 5, hard_limit_usd: 20, token_name: 'k1' } as any,
      },
    },
  } as any

  it('exposes supplierCredits = total_usage / 100 (真实美元；铁证 2026-08-06 门户/充值)', () => {
    // 铁证：充值 $50 → total_usage 增 5000；余额 $48.96 → 消耗 $1.25 → total_usage=125
    const info = normalizeNewApiBilling(baseSnapshot)
    expect(info.supplierCredits).toBeCloseTo(1.25, 6)
    expect(info.platformCredits).toBe(info.supplierCredits)
  })

  it('populates totalUsageUsd with the SAME numeric value for backward compat readers', () => {
    const info = normalizeNewApiBilling(baseSnapshot)
    expect(info.totalUsageUsd).toBe(info.platformCredits)
  })

  it('exports USD_TO_RMB (default 6.76, 2026-08-06 realtime) with legacy aliases', () => {
    expect(USD_TO_RMB).toBe(6.76)
    expect(SUPPLIER_CREDIT_TO_RMB).toBe(6.76)
    expect(PLATFORM_CREDIT_TO_RMB).toBe(6.76)
  })

  it('handles missing usage gracefully (null credits, null legacy alias)', () => {
    const snap = { ...baseSnapshot, endpoints: { ...baseSnapshot.endpoints, billing: { url: '', status: 500, fetchedAt: 1, success: false, error: 'x' } } } as any
    const info = normalizeNewApiBilling(snap)
    expect(info.supplierCredits).toBeNull()
    expect(info.platformCredits).toBeNull()
    expect(info.totalUsageUsd).toBeNull()
  })
})
