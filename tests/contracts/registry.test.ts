import { describe, expect, test } from 'vitest'

import { getContractById, resolveContract } from '../../src/contracts/registry.js'

describe('resolveContract', () => {
  test('newapi OpenAI text-to-image resolves to gpt-image-2 generate contract', () => {
    const result = resolveContract({
      modelId: 'gpt-image-2',
      supplier: 'newapi',
      protocol: 'openai',
      operation: 'text-to-image',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.contract.id).toBe('newapi.openai.gpt-image-2.generate')
    }
  })

  test('gpt-image-2-c resolves to c-specific generate contract with supportsN=false', () => {
    const result = resolveContract({
      modelId: 'gpt-image-2-c',
      supplier: 'newapi',
      protocol: 'openai',
      operation: 'text-to-image',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.contract.id).toBe('newapi.openai.gpt-image-2-c.generate')
      expect(result.contract.openai?.supportsN).toBe(false)
      expect(result.contract.openai?.maxN).toBe(1)
    }
  })

  test('newapi OpenAI image-edit for gpt-image-2 resolves to edit contract with multipart', () => {
    const result = resolveContract({
      modelId: 'gpt-image-2',
      supplier: 'newapi',
      protocol: 'openai',
      operation: 'image-edit',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.contract.id).toBe('newapi.openai.gpt-image-2.edit')
      expect(result.contract.openai?.contentType).toBe('multipart/form-data')
    }
  })

  test('newapi Gemini 2.5 generate contract does not declare imageSize', () => {
    const result = resolveContract({
      modelId: 'gemini-2.5-flash-image',
      supplier: 'newapi',
      protocol: 'gemini',
      operation: 'text-to-image',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.contract.gemini?.imageConfig.imageSizes).toEqual([])
      expect(result.contract.gemini?.imageConfig.imageSizeOptional).toBe(true)
    }
  })

  test('newapi Gemini 3 Pro generate contract declares uppercase 1K/2K/4K', () => {
    const result = resolveContract({
      modelId: 'gemini-3-pro-image-preview',
      supplier: 'newapi',
      protocol: 'gemini',
      operation: 'text-to-image',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.contract.gemini?.imageConfig.imageSizes).toEqual(['1K', '2K', '4K'])
    }
  })

  test('newapi Gemini 3 Pro edit contract does not send imageConfig', () => {
    const result = resolveContract({
      modelId: 'gemini-3-pro-image-preview',
      supplier: 'newapi',
      protocol: 'gemini',
      operation: 'image-edit',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.contract.gemini?.imageConfig.enabled).toBe(false)
    }
  })

  test('official Gemini contract does NOT include LOW/MEDIUM (fail-closed until confirmed)', () => {
    const result = resolveContract({
      modelId: 'any-model',
      supplier: 'gemini-official',
      protocol: 'gemini',
      operation: 'text-to-image',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const sizes = result.contract.gemini?.imageConfig.imageSizes ?? []
      expect(sizes).not.toContain('LOW')
      expect(sizes).not.toContain('MEDIUM')
      expect(sizes).toContain('1K')
    }
  })

  test('MJ imagine contract matches for MJ text-to-image and image-edit(→reference)', () => {
    const t2i = resolveContract({ modelId: 'mj_imagine', supplier: 'newapi', protocol: 'mj', operation: 'text-to-image' })
    expect(t2i.ok).toBe(true)
    if (t2i.ok) expect(t2i.contract.id).toBe('newapi.mj.imagine')

    const i2i = resolveContract({ modelId: 'mj_imagine', supplier: 'newapi', protocol: 'mj', operation: 'image-edit' })
    expect(i2i.ok).toBe(true)
    if (i2i.ok) expect(i2i.contract.id).toBe('newapi.mj.imagine.reference')
  })

  test('unknown supplier/protocol combos fail-closed', () => {
    const result = resolveContract({
      modelId: 'x',
      supplier: 'openai-official',
      protocol: 'mj',
      operation: 'text-to-image',
    })
    expect(result.ok).toBe(false)
  })

  test('getContractById returns known contract or undefined', () => {
    expect(getContractById('newapi.mj.imagine')?.protocol).toBe('mj')
    expect(getContractById('nonexistent-contract-id')).toBeUndefined()
  })
})
