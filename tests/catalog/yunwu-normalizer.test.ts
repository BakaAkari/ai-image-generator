import { describe, test, expect } from 'vitest'
import { loadJson } from './_fixture.js'
import { normalizeYunwuSnapshot } from '../../src/suppliers/yunwu/normalizer.js'
import type { YunwuRawSnapshot } from '../../src/suppliers/yunwu/raw-types.js'

describe('normalizeYunwuSnapshot', () => {
  test('produces executable models for known generation endpoints', () => {
    const snapshot = loadJson('snapshot.json') as YunwuRawSnapshot
    const catalog = normalizeYunwuSnapshot(snapshot as any)
    const gpt2 = catalog.models.find(m => m.id === 'gpt-image-2')
    expect(gpt2).toBeDefined()
    expect(gpt2!.executable).toBe(true)
    expect(gpt2!.routes).toHaveLength(2)
    expect(gpt2!.routes.map(r => r.protocol)).toContain('openai')
    
  })

  test('gemini model gets gemini route', () => {
    const snapshot = loadJson('snapshot.json') as YunwuRawSnapshot
    const catalog = normalizeYunwuSnapshot(snapshot as any)
    const gem = catalog.models.find(m => m.id === 'gemini-3-pro-image-preview')
    expect(gem).toBeDefined()
    expect(gem!.executable).toBe(true)
    expect(gem!.routes.map(r => r.protocol)).toContain('gemini')
  })

  test('non-executable models are marked unsupported', () => {
    const snapshot = loadJson('snapshot.json') as YunwuRawSnapshot
    const catalog = normalizeYunwuSnapshot(snapshot as any)
    for (const id of ['kling-avatar-image2video', 'kling-image-recognize', 'mj_upload', 'pixverse-image-template']) {
      const m = catalog.models.find(x => x.id === id)
      expect(m).toBeDefined()
      expect(m!.executable).toBe(false)
      expect(m!.routes).toHaveLength(0)
    }
  })

  test('executableModels projection excludes unsupported', () => {
    const snapshot = loadJson('snapshot.json') as YunwuRawSnapshot
    const catalog = normalizeYunwuSnapshot(snapshot as any)
    expect(catalog.executableModels.length).toBeLessThan(catalog.models.length)
    expect(catalog.executableModels.some(m => m.id === 'mj_upload')).toBe(false)
  })
})
