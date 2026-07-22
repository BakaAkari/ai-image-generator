import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { YunwuCatalogNormalizer, normalizeYunwuSnapshot } from '../../src/suppliers/yunwu/normalizer.js'
import type { YunwuRawSnapshot } from '../../src/suppliers/yunwu/raw-types.js'

function loadSnapshot(): YunwuRawSnapshot {
  const path = resolve(process.cwd(), 'tests/fixtures/yunwu/snapshot.json')
  return JSON.parse(readFileSync(path, 'utf-8')) as YunwuRawSnapshot
}

describe('YunwuCatalogNormalizer', () => {
  const normalizer = new YunwuCatalogNormalizer()
  const snapshot = loadSnapshot()
  const catalog = normalizer.normalize(snapshot)

  test('normalizes supplier and metadata', () => {
    expect(catalog.supplier).toBe('yunwu')
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

describe('normalizeYunwuSnapshot', () => {
  test('exposed function produces same shape as class', () => {
    const snapshot = loadSnapshot()
    const catalog = normalizeYunwuSnapshot(snapshot)
    expect(catalog.models.length).toBeGreaterThan(0)
    expect(catalog.allModels.length).toBeGreaterThan(catalog.models.length)
  })
})
