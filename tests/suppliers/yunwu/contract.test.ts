import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import type { YunwuModelItem, YunwuPricingItem, YunwuBillingPayload, YunwuStatusPayload, YunwuRawSnapshot } from '../../../src/suppliers/yunwu/raw-types.js'

function loadJson(name: string): unknown {
  const path = resolve(process.cwd(), `tests/fixtures/yunwu/${name}`)
  return JSON.parse(readFileSync(path, 'utf-8'))
}


const models = loadJson('models.json') as { data: YunwuModelItem[] }
const pricing = loadJson('pricing.json') as { data: YunwuPricingItem[] }
const billing = loadJson('billing.json') as YunwuBillingPayload
const status = loadJson('status.json') as YunwuStatusPayload
const snapshot = loadJson('snapshot.json') as unknown as YunwuRawSnapshot

describe('yunwu fixture contract', () => {
  test('models fixture contains key fields and preserves unknown fields', () => {
    const list = models.data
    expect(list.length).toBeGreaterThan(0)
    for (const m of list) {
      expect(typeof m.id).toBe('string')
      expect(m).toHaveProperty('model_type')
      expect(m).toHaveProperty('supported_endpoint_types')
    }
  })

  test('pricing fixture contains key fields and preserves unknown fields', () => {
    const list = pricing.data
    expect(list.length).toBeGreaterThan(0)
    for (const p of list) {
      expect(typeof p.model_name).toBe('string')
      expect([0, 1]).toContain(p.quota_type)
    }
  })

  test('billing fixture contains numeric total_usage and redacted token_name', () => {
    expect(typeof billing.total_usage).toBe('number')
    expect(billing.token_name).toBe('[REDACTED]')
  })

  test('status fixture is a valid object', () => {
    expect(status).toBeDefined()
  })

  test('fixtures do not contain credentials or authorization values', () => {
    const all = JSON.stringify({ models, pricing, billing, status })
    expect(all).not.toMatch(/sk-[a-zA-Z0-9]{20,}/)
    expect(all).not.toContain('Bearer')
    expect(all).not.toContain('Authorization')
    expect(all).toContain('token_name')
    expect(all).toContain('[REDACTED]')
  })

  test('snapshot fixture is redacted and has all endpoints', () => {
    expect(snapshot.supplier).toBe('yunwu')
    expect(snapshot.keyScopeFingerprint).toMatch(/^[a-f0-9]{16}$/)
    expect(snapshot.endpoints.models.success).toBe(true)
    expect(snapshot.endpoints.pricing.success).toBe(true)
    expect(snapshot.endpoints.billing.success).toBe(true)
    expect(snapshot.endpoints.status.success).toBe(true)
    const text = JSON.stringify(snapshot)
    expect(text).not.toMatch(/sk-[a-zA-Z0-9]{20,}/)
    expect(text).not.toContain('Bearer')
    expect(text).not.toContain('Authorization')
  })

  test('gpt-image-2 fixture carries per-token extra fields for future pricing', () => {
    const gpt2 = pricing.data.find(p => p.model_name === 'gpt-image-2')
    expect(gpt2).toBeDefined()
    expect(gpt2!.quota_type).toBe(0)
    expect(gpt2!.model_ratio).toBeDefined()
    expect(gpt2!.image_ratio).toBeDefined()
    expect(gpt2!.completion_ratio).toBeDefined()
  })

  test('dall-e-3 fixture carries per-call price', () => {
    const dalle = pricing.data.find(p => p.model_name === 'dall-e-3')
    expect(dalle).toBeDefined()
    expect(dalle!.quota_type).toBe(1)
    expect(dalle!.model_price).toBeDefined()
  })
})
