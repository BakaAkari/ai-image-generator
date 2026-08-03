import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { NewApiCatalogNormalizer, normalizeNewApiSnapshot } from '../../src/suppliers/newapi/normalizer.js'
import type { NewApiRawSnapshot } from '../../src/suppliers/newapi/raw-types.js'

function loadSnapshot(): NewApiRawSnapshot {
  const path = resolve(process.cwd(), 'tests/fixtures/newapi/snapshot.json')
  return JSON.parse(readFileSync(path, 'utf-8')) as NewApiRawSnapshot
}

describe('NewApiCatalogNormalizer', () => {
  const normalizer = new NewApiCatalogNormalizer()
  const snapshot = loadSnapshot()
  const catalog = normalizer.normalize(snapshot)

  test('normalizes supplier and metadata', () => {
    expect(catalog.supplier).toBe('newapi')
    expect(catalog.schemaVersion).toBe(1)
    expect(catalog.parserVersion).toBe('1.0.0')
    expect(catalog.keyScopeFingerprint).toMatch(/^[a-f0-9]{16}$/)
    expect(catalog.fetchedAt).toBe(snapshot.fetchedAt)
  })

  test('executable models contain expected generation models', () => {
    const ids = catalog.models.map(m => m.id).sort()
    expect(ids).toContain('dall-e-3')
    expect(ids).toContain('gemini-3-pro-image')
    expect(ids).toContain('gemini-3-pro-image-preview')
    expect(ids).toContain('gpt-image-2')
    expect(ids).toContain('gpt-image-2-c')
    expect(ids).toContain('grok-imagine-image')
  })


  test('preserves normalized supplier pricing on catalog models', () => {
    const model = catalog.allModels.find(m => m.id === 'dall-e-3')!
    expect(model.pricing).toMatchObject({ type: 'per-call', source: 'remote-pricing' })
    expect(model.pricing.pricePerCall).toBeTypeOf('number')
  })

  test('negative models are not executable', () => {
    const ids = catalog.models.map(m => m.id)
    expect(ids).not.toContain('kling-avatar-image2video')
    expect(ids).not.toContain('kling-image-recognize')
    expect(ids).not.toContain('mj_upload')
    expect(ids).not.toContain('pixverse-image-template')
    expect(ids).not.toContain('mj_video')
  })

  test('allModels retains unsupported models', () => {
    const allIds = catalog.allModels.map(m => m.id)
    expect(allIds).toContain('kling-avatar-image2video')
    expect(allIds).toContain('kling-image-recognize')
    expect(allIds).toContain('mj_upload')
    expect(allIds).toContain('pixverse-image-template')
    expect(allIds).toContain('mj_video')
  })

  test('unsupported models have reasons', () => {
    const unsupported = catalog.allModels.filter(m => !m.executable)
    for (const m of unsupported) {
      expect(m.unsupportedReasons).toBeDefined()
      expect(m.unsupportedReasons!.length).toBeGreaterThan(0)
    }
  })

  test('gpt-image-2 has openai routes for edit and generation', () => {
    const model = catalog.models.find(m => m.id === 'gpt-image-2')!
    expect(model.routes).toContainEqual({
      id: 'openai:image-edit',
      protocol: 'openai',
      capability: 'image-edit',
      endpointName: 'openai编辑图片',
    })
    expect(model.routes).toContainEqual({
      id: 'openai:text-to-image',
      protocol: 'openai',
      capability: 'text-to-image',
      endpointName: 'image-generation',
    })
  })

  test('gemini-3-pro-image has gemini and openai routes', () => {
    const model = catalog.models.find(m => m.id === 'gemini-3-pro-image')!
    const protocols = model.routes.map(r => r.protocol)
    expect(protocols).toContain('gemini')
    expect(protocols).toContain('openai')
  })

  test('dall-e-3 has openai route via fallback capability mapping', () => {
    const model = catalog.models.find(m => m.id === 'dall-e-3')!
    expect(model.routes).toContainEqual({
      id: 'openai:text-to-image',
      protocol: 'openai',
      capability: 'text-to-image',
      endpointName: 'dall-e-3',
    })
  })

  test('executable() returns only executable models', () => {
    const exec = normalizer.executable(catalog)
    expect(exec.every(m => m.executable)).toBe(true)
  })

  test('unsupported() returns only non-executable models', () => {
    const unsup = normalizer.unsupported(catalog)
    expect(unsup.every(m => !m.executable)).toBe(true)
  })
})

describe('normalizeNewApiSnapshot', () => {
  test('exposed function produces same shape as class', () => {
    const snapshot = loadSnapshot()
    const catalog = normalizeNewApiSnapshot(snapshot)
    expect(catalog.models.length).toBeGreaterThan(0)
    expect(catalog.allModels.length).toBeGreaterThan(catalog.models.length)
  })

  test('endpointAliases make an aliased MJ model executable', () => {
    const snapshot = structuredClone(loadSnapshot())
    // fixture 不含 mj_imagine，注入一个带 openlux 英文 endpoint 的模型
    const models = snapshot.endpoints.models as unknown as { success: boolean; data: { data: unknown[] } }
    const rows = models.data?.data ?? []
    models.data = {
      ...models.data,
      data: [
        ...rows,
        {
          id: 'mj_imagine',
          model_type: '图像',
          description: 'Midjourney imagine mode.',
          supported_endpoint_types: ['MJ imagine'],
          available: true,
        },
      ],
    }
    // 语义规则引擎直接识别 `MJ imagine` → mj:text-to-image → executable（无需别名）
    const withoutAlias = normalizeNewApiSnapshot(snapshot)
    const row = withoutAlias.allModels.find(m => m.id === 'mj_imagine')
    expect(row?.executable).toBe(true)
    expect(row?.routes.some(r => r.id === 'mj:text-to-image')).toBe(true)

    // 带别名：'MJ imagine' → mj:text-to-image → 结果一致，别名作为显式覆盖仍生效
    const withAlias = normalizeNewApiSnapshot(snapshot, {
      'MJ imagine': { protocol: 'mj', capability: 'text-to-image' },
    })
    const aliasRow = withAlias.allModels.find(m => m.id === 'mj_imagine')
    expect(aliasRow?.executable).toBe(true)
    expect(aliasRow?.routes.some(r => r.id === 'mj:text-to-image')).toBe(true)
  })
})
