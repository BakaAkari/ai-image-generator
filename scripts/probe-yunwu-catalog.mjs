#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

const KNOWN_GENERATION_ENDPOINTS = new Set(['image-generation', 'images/generations', 'openai-绘图', 'openai-编辑', 'openai编辑图片', 'dall-e-3', 'dall-e-2', 'openai', 'gemini'])
const KNOWN_NON_GENERATION_ENDPOINTS = new Set(['数字人', '图像识别', 'mj图片上传', '图片模板'])

export function redactText(value) {
  return String(value)
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/(token_name\s*[=:]\s*)[^\s,}\]]+/gi, '$1[REDACTED]')
}

export async function runProbe(options) {
  const apiBase = String(options.apiBase || '').replace(/\/+$/, '').replace(/\/v1$/, '')
  const apiKey = String(options.apiKey || '')
  const fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis)
  const endpoints = ['/v1/models', '/api/pricing', '/v1/dashboard/billing/usage', '/v1/dashboard/billing/subscription']
  const results = {}
  const errors = []

  await Promise.all(endpoints.map(async endpoint => {
    try {
      const response = await fetchImpl(`${apiBase}${endpoint}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      })
      if (!response.ok) {
        const text = redactText(await response.text().catch(() => ''))
        errors.push({ endpoint, status: response.status, error: text.slice(0, 200) })
        return
      }
      results[endpoint] = await response.json()
    } catch (error) {
      errors.push({ endpoint, status: 0, error: redactText(error instanceof Error ? error.message : error) })
    }
  }))

  const models = Array.isArray(results['/v1/models']?.data) ? results['/v1/models'].data : []
  const pricing = Array.isArray(results['/api/pricing']?.data) ? results['/api/pricing'].data : []
  const endpointNames = [...new Set(models.flatMap(model => Array.isArray(model.supported_endpoint_types) ? model.supported_endpoint_types : []))]
  const unknownEndpoints = endpointNames.filter(endpoint => !KNOWN_GENERATION_ENDPOINTS.has(endpoint) && !KNOWN_NON_GENERATION_ENDPOINTS.has(endpoint)).sort()
  const schema = { models: collectKeys(models), pricing: collectKeys(pricing) }
  const baseline = options.baseline || { models: [], pricing: [] }
  const schemaDiff = {
    models: diffKeys(baseline.models || [], schema.models),
    pricing: diffKeys(baseline.pricing || [], schema.pricing),
  }

  return {
    exitCode: errors.length ? 2 : 0,
    supplier: 'yunwu',
    apiBase,
    summary: { models: models.length, pricing: pricing.length, endpointTypes: endpointNames.length },
    unknownEndpoints,
    schema,
    schemaDiff,
    errors,
    billing: {
      usageAvailable: Boolean(results['/v1/dashboard/billing/usage']),
      subscriptionAvailable: Boolean(results['/v1/dashboard/billing/subscription']),
    },
  }
}

function collectKeys(rows) {
  return [...new Set(rows.flatMap(row => row && typeof row === 'object' ? Object.keys(row) : []))].sort()
}
function diffKeys(before, after) {
  const previous = new Set(before)
  const current = new Set(after)
  return { added: after.filter(key => !previous.has(key)), removed: before.filter(key => !current.has(key)) }
}

async function main() {
  const apiBase = process.env.YUNWU_API_BASE || 'https://yunwu.ai/v1'
  const apiKey = process.env.YUNWU_API_KEY || ''
  if (!apiKey) {
    console.error(JSON.stringify({ exitCode: 1, error: 'YUNWU_API_KEY is required' }))
    process.exitCode = 1
    return
  }
  const report = await runProbe({ apiBase, apiKey })
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.exitCode
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main()
