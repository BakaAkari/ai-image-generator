import { describe, expect, test } from 'vitest'

import { getContractById } from '../../src/contracts/registry.js'
import {
  availableAspectRatios,
  availableResolutionLevels,
  levelsForAspectRatio,
  resolveOpenAiSize,
} from '../../src/contracts/openai-size.js'

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

  test('组合 miss 错误文案列出可用组合（1K 可用比例 + 9:16 可用等级）', () => {
    const r = resolveOpenAiSize({ resolution: '1k', aspectRatio: '9:16', capability: cap })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('1K + 9:16')
      expect(r.error).toContain('1K 可用比例：1:1、3:2、2:3')
      expect(r.error).toContain('9:16 可用于：4K')
    }
  })

  test('组合 miss 且比例在全表不可用时不输出「可用于」段', () => {
    const r = resolveOpenAiSize({ resolution: '2k', aspectRatio: '3:2', capability: cap })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('2K 可用比例：1:1、16:9')
      expect(r.error).toContain('3:2 可用于：1K')
    }
  })
})

describe('openai-size 组合辅助函数', () => {
  test('availableResolutionLevels 返回有映射的等级', () => {
    expect(availableResolutionLevels(cap)).toEqual(['1k', '2k', '4k'])
  })

  test('availableAspectRatios 按等级收窄', () => {
    expect(availableAspectRatios(cap, '1k')).toEqual(['1:1', '3:2', '2:3'])
    expect(availableAspectRatios(cap, '2k')).toEqual(['1:1', '16:9'])
    expect(availableAspectRatios(cap, '4k')).toEqual(['16:9', '9:16'])
  })

  test('levelsForAspectRatio 反查比例可用等级', () => {
    expect(levelsForAspectRatio(cap, '9:16')).toEqual(['4k'])
    expect(levelsForAspectRatio(cap, '1:1')).toEqual(['1k', '2k'])
    expect(levelsForAspectRatio(cap, '4:3')).toEqual([])
  })
})
