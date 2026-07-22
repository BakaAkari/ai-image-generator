import { describe, test, expect } from 'vitest'
import { YunwuClient, createKeyScopeFingerprint } from '../../../src/suppliers/yunwu/client.js'
import type { YunwuModelItem, YunwuPricingItem } from '../../../src/suppliers/yunwu/raw-types.js'

describe('YunwuClient', () => {
  const makeClient = (
    fetchLike: (url: string, init?: RequestInit) => Promise<Response>,
    overrides?: { apiBase?: string; apiKey?: string; timeoutSec?: number }
  ) => new YunwuClient({ apiBase: 'https://api.yunwu.ai/v1', apiKey: 'sk-secret', timeoutSec: 30, ...overrides }, fetchLike)

  test('fetchSnapshot requests /v1/models, /api/pricing, /v1/dashboard/billing/usage, /v1/dashboard/billing/subscription', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const client = makeClient(async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [] }))
      if (url.endsWith('/api/pricing')) return new Response(JSON.stringify({ data: [] }))
      if (url.includes('/billing/usage')) return new Response(JSON.stringify({ total_usage: 0 }))
      if (url.includes('/billing/subscription')) return new Response(JSON.stringify({}))
      throw new Error(`unexpected ${url}`)
    })

    const snapshot = await client.fetchSnapshot()

    expect(calls.map(c => c.url).sort()).toEqual([
      'https://api.yunwu.ai/api/pricing',
      'https://api.yunwu.ai/v1/dashboard/billing/subscription',
      'https://api.yunwu.ai/v1/dashboard/billing/usage',
      'https://api.yunwu.ai/v1/models',
    ])
    expect(snapshot.endpoints.models.status).toBe(200)
    expect(snapshot.endpoints.pricing.status).toBe(200)
    expect(snapshot.endpoints.billing.status).toBe(200)
    expect(snapshot.endpoints.status.status).toBe(200)
  })

  test('fetchSnapshot normalizes trailing /v1 to base host for management endpoints', async () => {
    const client = new YunwuClient(
      { apiBase: 'https://api.yunwu.ai/v1/', apiKey: 'sk-secret', timeoutSec: 30 },
      async (url) => {
        if (url.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [] }))
        if (url.endsWith('/api/pricing')) return new Response(JSON.stringify({ data: [] }))
        if (url.includes('/billing/usage')) return new Response(JSON.stringify({ total_usage: 0 }))
        if (url.includes('/billing/subscription')) return new Response(JSON.stringify({}))
        throw new Error(`unexpected ${url}`)
      }
    )

    const snapshot = await client.fetchSnapshot()
    expect(snapshot.supplier).toBe('yunwu')
  })

  test('fetchSnapshot does not serialize apiKey or Authorization header in snapshot', async () => {
    const client = new YunwuClient(
      { apiBase: 'https://api.yunwu.ai/v1', apiKey: 'sk-secret', timeoutSec: 30 },
      async () => new Response(JSON.stringify({ data: [] }))
    )

    const snapshot = await client.fetchSnapshot()
    const json = JSON.stringify(snapshot)

    expect(json).not.toContain('sk-secret')
    expect(json).not.toContain('Authorization')
  })

  test('fetchSnapshot includes keyScopeFingerprint in snapshot', async () => {
    const client = new YunwuClient(
      { apiBase: 'https://api.yunwu.ai/v1', apiKey: 'sk-secret', timeoutSec: 30 },
      async () => new Response(JSON.stringify({ data: [] }))
    )

    const snapshot = await client.fetchSnapshot()
    const expected = createKeyScopeFingerprint({ supplier: 'yunwu', apiBase: 'https://api.yunwu.ai/v1', apiKey: 'sk-secret' })
    expect(snapshot.keyScopeFingerprint).toBe(expected)
  })

  test('fingerprint changes when apiKey or apiBase changes', () => {
    const f1 = createKeyScopeFingerprint({ supplier: 'yunwu', apiBase: 'https://a/v1', apiKey: 'k1' })
    const f2 = createKeyScopeFingerprint({ supplier: 'yunwu', apiBase: 'https://a/v1', apiKey: 'k2' })
    const f3 = createKeyScopeFingerprint({ supplier: 'yunwu', apiBase: 'https://b/v1', apiKey: 'k1' })
    expect(f1).not.toBe(f2)
    expect(f1).not.toBe(f3)
  })

  test('fetchSnapshot propagates AbortSignal to all requests', async () => {
    const controllers: AbortSignal[] = []
    const client = new YunwuClient(
      { apiBase: 'https://api.yunwu.ai/v1', apiKey: 'sk-secret', timeoutSec: 30 },
      async (_url, init) => {
        controllers.push(init!.signal!)
        return new Response(JSON.stringify({ data: [] }))
      }
    )

    const aborter = new AbortController()
    await client.fetchSnapshot(aborter.signal)
    expect(controllers.length).toBe(4)
    for (const s of controllers) {
      expect(s.aborted).toBe(false)
    }
  })

  test('fetchSnapshot preserves raw unknown fields on endpoint data', async () => {
    const client = new YunwuClient(
      { apiBase: 'https://api.yunwu.ai/v1', apiKey: 'sk-secret', timeoutSec: 30 },
      async (url) => {
        if (url.endsWith('/v1/models')) {
          return new Response(JSON.stringify({
            data: [{ id: 'm', unknown_field: 'keep', image_ratio: 1.5 } as YunwuModelItem]
          }))
        }
        if (url.endsWith('/api/pricing')) {
          return new Response(JSON.stringify({
            data: [{ model_name: 'm', extra_pricing: 42 } as unknown as YunwuPricingItem]
          }))
        }
        if (url.includes('/billing/usage')) return new Response(JSON.stringify({ total_usage: 0 }))
        if (url.includes('/billing/subscription')) return new Response(JSON.stringify({}))
        throw new Error(`unexpected ${url}`)
      }
    )

    const snapshot = await client.fetchSnapshot()
    const modelsArray = (snapshot.endpoints.models.data!.data) as YunwuModelItem[]
    expect(modelsArray).toHaveLength(1)
    expect((modelsArray[0] as any).unknown_field).toBe('keep')
    expect(((snapshot.endpoints.pricing.data!.data)[0] as any).extra_pricing).toBe(42)
  })

  test('fetchSnapshot reports HTTP errors without throwing', async () => {
    const client = new YunwuClient(
      { apiBase: 'https://api.yunwu.ai/v1', apiKey: 'sk-secret', timeoutSec: 30 },
      async (url) => {
        if (url.endsWith('/api/pricing')) return new Response('forbidden', { status: 403 })
        return new Response(JSON.stringify({ data: [] }))
      }
    )

    const snapshot = await client.fetchSnapshot()
    expect(snapshot.endpoints.pricing.status).toBe(403)
    expect(snapshot.endpoints.pricing.success).toBe(false)
    expect(snapshot.endpoints.pricing.error).toContain('403')
  })
})

describe('createKeyScopeFingerprint', () => {
  test('produces stable truncated digest', () => {
    const f = createKeyScopeFingerprint({ supplier: 'yunwu', apiBase: 'https://api.yunwu.ai/v1', apiKey: 'sk-secret' })
    expect(f).toMatch(/^[a-f0-9]{16}$/)
  })
})
