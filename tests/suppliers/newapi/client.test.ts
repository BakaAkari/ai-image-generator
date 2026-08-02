import { describe, test, expect } from 'vitest'
import { NewApiClient, createKeyScopeFingerprint } from '../../../src/suppliers/newapi/client.js'
import type { NewApiModelItem, NewApiPricingItem } from '../../../src/suppliers/newapi/raw-types.js'

describe('NewApiClient', () => {
  const makeClient = (
    fetchLike: (url: string, init?: RequestInit) => Promise<Response>,
    overrides?: { apiBase?: string; apiKey?: string; timeoutSec?: number; endpoints?: import('../../../src/suppliers/newapi/client.js').SupplierEndpointsConfig }
  ) => new NewApiClient({ apiBase: 'https://api.newapi.test/v1', apiKey: 'sk-secret', timeoutSec: 30, ...overrides }, fetchLike)

  test('fetchSnapshot requests default /v1/models, /api/pricing, /v1/dashboard/billing/usage, /v1/dashboard/billing/subscription', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const client = makeClient(async (url, init) => {
      calls.push({ url, init })
      if (url.includes('/v1/models')) return new Response(JSON.stringify({ data: [] }))
      if (url.includes('/api/pricing')) return new Response(JSON.stringify({ data: [] }))
      if (url.includes('/billing/usage')) return new Response(JSON.stringify({ total_usage: 0 }))
      if (url.includes('/billing/subscription')) return new Response(JSON.stringify({}))
      throw new Error(`unexpected ${url}`)
    })

    const snapshot = await client.fetchSnapshot()

    expect(calls.map(c => c.url).sort()).toEqual([
      'https://api.newapi.test/api/pricing',
      'https://api.newapi.test/v1/dashboard/billing/subscription',
      'https://api.newapi.test/v1/dashboard/billing/usage',
      'https://api.newapi.test/v1/models',
    ])
    expect(snapshot.endpoints.models.status).toBe(200)
    expect(snapshot.endpoints.pricing.status).toBe(200)
    expect(snapshot.endpoints.billing.status).toBe(200)
    expect(snapshot.endpoints.status.status).toBe(200)
  })

  test('usageQuery appends encoded query string to usage endpoint', async () => {
    const calls: { url: string }[] = []
    const client = makeClient(
      async (url) => {
        calls.push({ url })
        if (url.includes('/v1/models')) return new Response(JSON.stringify({ data: [] }))
        if (url.includes('/api/pricing')) return new Response(JSON.stringify({ data: [] }))
        if (url.includes('/billing/usage')) return new Response(JSON.stringify({ total_usage: 100 }))
        if (url.includes('/billing/subscription')) return new Response(JSON.stringify({}))
        throw new Error(`unexpected ${url}`)
      },
      {
        endpoints: {
          usageQuery: { start_date: '2026-07-01', end_date: '2026-08-02' },
        },
      }
    )

    const snapshot = await client.fetchSnapshot()

    const usageCall = calls.find(c => c.url.includes('/billing/usage'))
    expect(usageCall?.url).toBe('https://api.newapi.test/v1/dashboard/billing/usage?start_date=2026-07-01&end_date=2026-08-02')
    expect(snapshot.endpoints.billing.status).toBe(200)
    expect(snapshot.endpoints.billing.data).toEqual({ total_usage: 100 })
  })

  test('fetchSnapshot does not serialize apiKey or Authorization header in snapshot', async () => {
    const client = makeClient(async () => new Response(JSON.stringify({ data: [] })))

    const snapshot = await client.fetchSnapshot()
    const json = JSON.stringify(snapshot)

    expect(json).not.toContain('sk-secret')
    expect(json).not.toContain('Authorization')
  })

  test('fetchSnapshot normalizes trailing /v1 to base host for management endpoints', async () => {
    const client = new NewApiClient(
      { apiBase: 'https://api.newapi.test/v1/', apiKey: 'sk-secret', timeoutSec: 30 },
      async (url) => {
        if (url.includes('/v1/models')) return new Response(JSON.stringify({ data: [] }))
        if (url.includes('/api/pricing')) return new Response(JSON.stringify({ data: [] }))
        if (url.includes('/billing/usage')) return new Response(JSON.stringify({ total_usage: 0 }))
        if (url.includes('/billing/subscription')) return new Response(JSON.stringify({}))
        throw new Error(`unexpected ${url}`)
      }
    )

    const snapshot = await client.fetchSnapshot()
    expect(snapshot.supplier).toBe('newapi')
  })

  test('fetchSnapshot preserves raw unknown fields on endpoint data', async () => {
    const client = makeClient(
      async (url) => {
        if (url.includes('/v1/models')) {
          return new Response(JSON.stringify({
            data: [{ id: 'm', unknown_field: 'keep', image_ratio: 1.5 } as NewApiModelItem]
          }))
        }
        if (url.includes('/api/pricing')) {
          return new Response(JSON.stringify({
            data: [{ model_name: 'm', extra_pricing: 42 } as unknown as NewApiPricingItem]
          }))
        }
        if (url.includes('/billing/usage')) return new Response(JSON.stringify({ total_usage: 0 }))
        if (url.includes('/billing/subscription')) return new Response(JSON.stringify({}))
        throw new Error(`unexpected ${url}`)
      }
    )

    const snapshot = await client.fetchSnapshot()
    const modelsArray = (snapshot.endpoints.models.data!.data) as NewApiModelItem[]
    expect(modelsArray).toHaveLength(1)
    expect((modelsArray[0] as any).unknown_field).toBe('keep')
    expect(((snapshot.endpoints.pricing.data!.data)[0] as any).extra_pricing).toBe(42)
  })
})

describe('createKeyScopeFingerprint', () => {
  test('produces stable truncated digest', () => {
    const f = createKeyScopeFingerprint({ supplier: 'newapi', apiBase: 'https://api.newapi.test/v1', apiKey: 'sk-secret' })
    expect(f).toMatch(/^[a-f0-9]{16}$/)
  })
})
