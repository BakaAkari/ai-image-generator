import { describe, expect, test } from 'vitest'

import { getContractById } from '../../src/contracts/registry.js'
import { resolveOpenAiSize } from '../../src/contracts/openai-size.js'

const GPT_IMAGE_2_GENERATE = getContractById('yunwu.openai.gpt-image-2.generate')!
const cap = GPT_IMAGE_2_GENERATE.openai!.size!

describe('resolveOpenAiSize (GPT Image 2)', () => {
  test('1k + 1:1 → 1024x1024', () => {
    const r = resolveOpenAiSize({ resolution: '1k', aspectRatio: '1:1', capability: cap })
    expect(r.ok && r.size).toBe('1024x1024')
  })

  test('2k + 1:1 → 2048x2048', () => {
    const r = resolveOpenAiSize({ resolution: '2k', aspectRatio: '1:1', capability: cap })
    expect(r.ok && r.size).toBe('2048x2048')
  })

  test('2k + 16:9 → 2048x1152', () => {
    const r = resolveOpenAiSize({ resolution: '2k', aspectRatio: '16:9', capability: cap })
    expect(r.ok && r.size).toBe('2048x1152')
  })

  test('4k + 16:9 → 3840x2160', () => {
    const r = resolveOpenAiSize({ resolution: '4k', aspectRatio: '16:9', capability: cap })
    expect(r.ok && r.size).toBe('3840x2160')
  })

  test('4k + 9:16 → 2160x3840', () => {
    const r = resolveOpenAiSize({ resolution: '4k', aspectRatio: '9:16', capability: cap })
    expect(r.ok && r.size).toBe('2160x3840')
  })

  test('4:3 fails-closed (契约不映射到 3:2 的 1536x1024)', () => {
    const r = resolveOpenAiSize({ resolution: '1k', aspectRatio: '4:3', capability: cap })
    expect(r.ok).toBe(false)
  })

  test('3:2 + 1k → 1536x1024', () => {
    const r = resolveOpenAiSize({ resolution: '1k', aspectRatio: '3:2', capability: cap })
    expect(r.ok && r.size).toBe('1536x1024')
  })

  test('valid custom size 1024x1024 passes limits', () => {
    const r = resolveOpenAiSize({ resolution: '1024x1024', capability: cap })
    expect(r.ok && r.size).toBe('1024x1024')
  })

  test('custom size not multiples of 16 → rejected', () => {
    const r = resolveOpenAiSize({ resolution: '1025x1024', capability: cap })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('16')
  })

  test('custom size violates 3:1 ratio → rejected', () => {
    const r = resolveOpenAiSize({ resolution: '3840x1024', capability: cap })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('3')
  })

  test('custom size > 3840 max side → rejected', () => {
    const r = resolveOpenAiSize({ resolution: '4096x2048', capability: cap })
    expect(r.ok).toBe(false)
  })

  test('custom size total pixels < min → rejected', () => {
    const r = resolveOpenAiSize({ resolution: '512x512', capability: cap })
    expect(r.ok).toBe(false)
  })

  test('no params + supportsAuto → auto', () => {
    const r = resolveOpenAiSize({ capability: cap })
    expect(r.ok && r.size).toBe('auto')
  })
})
