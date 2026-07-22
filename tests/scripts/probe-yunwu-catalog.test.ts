import { describe, expect, test, vi } from 'vitest'
import { runProbe, redactText } from '../../scripts/probe-yunwu-catalog.mjs'

const responses: Record<string, unknown> = {
  '/v1/models': { data: [{ id: 'm1', model_type: '图像', supported_endpoint_types: ['image-generation'], new_model_field: 1 }, { id: 'm2', supported_endpoint_types: ['mystery-endpoint'] }] },
  '/api/pricing': { data: [{ model_name: 'm1', quota_type: 1, model_price: 0.01, image_ratio: 2, new_price_field: true }] },
  '/v1/dashboard/billing/usage': { total_usage: 123, token_name: 'secret-token-name' },
  '/v1/dashboard/billing/subscription': { hard_limit_usd: 50 },
}

function fetchImpl(url: string) {
  const path = new URL(url).pathname
  return Promise.resolve(new Response(JSON.stringify(responses[path]), { status: 200 }))
}

describe('yunwu catalog probe', () => {
  const fakeSecret = `sk-${'a'.repeat(24)}`
  test('redacts API keys, bearer values and token names', () => {
    expect(redactText(`Bearer ${fakeSecret} token_name=secret`)).not.toContain(fakeSecret)
    expect(redactText(`Bearer ${fakeSecret} token_name=secret`)).toContain('[REDACTED]')
  })

  test('is read-only and returns sanitized endpoint/count/schema report', async () => {
    const report = await runProbe({ apiBase: 'https://yunwu.ai/v1', apiKey: fakeSecret, fetchImpl })
    expect(report.exitCode).toBe(0)
    expect(report.summary.models).toBe(2)
    expect(report.summary.pricing).toBe(1)
    expect(report.unknownEndpoints).toContain('mystery-endpoint')
    expect(report.schema.models).toContain('new_model_field')
    expect(report.schema.pricing).toContain('new_price_field')
    expect(JSON.stringify(report)).not.toContain(fakeSecret)
    expect(fetchImpl).not.toHaveProperty('write')
  })

  test('reports schema additions against a baseline', async () => {
    const report = await runProbe({
      apiBase: 'https://yunwu.ai/v1', apiKey: 'test', fetchImpl,
      baseline: { models: ['id', 'model_type', 'supported_endpoint_types'], pricing: ['model_name', 'quota_type', 'model_price'] },
    })
    expect(report.schemaDiff.models.added).toContain('new_model_field')
    expect(report.schemaDiff.pricing.added).toContain('new_price_field')
  })

  test('returns nonzero exit code on endpoint failure without leaking auth', async () => {
    const report = await runProbe({
      apiBase: 'https://yunwu.ai/v1', apiKey: fakeSecret,
      fetchImpl: async () => new Response(`Bearer ${fakeSecret}`, { status: 500 }),
    })
    expect(report.exitCode).toBe(2)
    expect(JSON.stringify(report)).not.toContain(fakeSecret)
  })
})
