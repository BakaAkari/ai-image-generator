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

  test('MJ compose-image matches blend contract (not imagine reference)', () => {
    const compose = resolveContract({ modelId: 'mj_imagine', supplier: 'newapi', protocol: 'mj', operation: 'compose-image' })
    expect(compose.ok).toBe(true)
    if (compose.ok) expect(compose.contract.id).toBe('newapi.mj.blend')
    expect(compose.ok && compose.contract.endpoint).toBe('/mj/submit/blend')
  })

  test('MJ blend contract registered with correct fields', () => {
    const blend = getContractById('newapi.mj.blend')
    expect(blend?.protocol).toBe('mj')
    expect(blend?.operation).toBe('compose-image')
    expect(blend?.endpoint).toBe('/mj/submit/blend')
    expect(blend?.method).toBe('POST')
    expect(blend?.modelIds).toBe('*')
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

  test('qwen-image-max resolves to newapi qwen generate contract (supportsN=false)', () => {
    const r1 = resolveContract({ modelId: 'qwen-image-max', supplier: 'newapi', protocol: 'openai', operation: 'text-to-image' })
    expect(r1.ok).toBe(true)
    if (r1.ok) {
      expect(r1.contract.id).toBe('newapi.openai.qwen-image-max.generate')
      expect(r1.contract.openai?.supportsN).toBe(false)
      expect(r1.contract.openai?.maxN).toBe(1)
      expect(r1.contract.endpoint).toBe('/v1/images/generations')
    }
    const r2 = resolveContract({ modelId: 'qwen-image-max-2025-12-30', supplier: 'newapi', protocol: 'openai', operation: 'text-to-image' })
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.contract.id).toBe('newapi.openai.qwen-image-max.generate')
  })

  test('grok-imagine-image resolves to newapi grok generate contract', () => {
    const r1 = resolveContract({ modelId: 'grok-imagine-image', supplier: 'newapi', protocol: 'openai', operation: 'text-to-image' })
    expect(r1.ok).toBe(true)
    if (r1.ok) {
      expect(r1.contract.id).toBe('newapi.openai.grok-imagine.generate')
      expect(r1.contract.openai?.supportsN).toBe(false)
    }
    const r2 = resolveContract({ modelId: 'grok-imagine-image-pro', supplier: 'newapi', protocol: 'openai', operation: 'text-to-image' })
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.contract.id).toBe('newapi.openai.grok-imagine.generate')
  })

  test('qwen/grok contracts reject 2k/4k resolution and auto (fail-closed, no custom size)', () => {
    const qwen = getContractById('newapi.openai.qwen-image-max.generate')
    const sizes = qwen?.openai?.size
    expect(sizes?.fixedSizes).toContain('1024x1024')
    expect(sizes?.customSizeLimits).toBeUndefined()
    expect(sizes?.supportsAuto).toBeUndefined()
    expect(sizes?.fixedSizes).not.toContain('auto')
    const grok = getContractById('newapi.openai.grok-imagine.generate')
    expect(grok?.openai?.size?.customSizeLimits).toBeUndefined()
    expect(grok?.openai?.size?.fixedSizes).not.toContain('auto')
  })

  test('getContractById returns known contract or undefined', () => {
    expect(getContractById('newapi.mj.imagine')?.protocol).toBe('mj')
    expect(getContractById('nonexistent-contract-id')).toBeUndefined()
  })
})
