import { describe, expect, test } from 'vitest'

import { getContractById } from '../../src/contracts/registry.js'
import { resolveContractParams } from '../../src/contracts/param-resolver.js'

const OPENAI_GEN = getContractById('newapi.openai.gpt-image-2.generate')!
const OPENAI_C = getContractById('newapi.openai.gpt-image-2-c.generate')!
const GEMINI_2_5 = getContractById('newapi.gemini.2-5.generate')!
const GEMINI_3_PRO = getContractById('newapi.gemini.3-pro.generate')!
const GEMINI_3_PRO_EDIT = getContractById('newapi.gemini.3-pro.edit')!
const MJ_IMAGINE = getContractById('newapi.mj.imagine')!

describe('resolveContractParams (OpenAI)', () => {
  test('resolution 1k + aspectRatio 16:9 → size 2048x1152', () => {
    const r = resolveContractParams(OPENAI_GEN, { resolution: '2k', aspectRatio: '16:9', n: 1 })
    expect(r.fields.size).toBe('2048x1152')
    expect(r.rejected).toEqual([])
    expect(r.numImages).toBe(1)
  })

  test('4:3 explicit + 1k → rejected size (no silent 3:2 mapping)', () => {
    const r = resolveContractParams(OPENAI_GEN, { resolution: '1k', aspectRatio: '4:3', n: 1 })
    expect(r.rejected.some(x => x.key === 'size')).toBe(true)
    expect(r.fields.size).toBeUndefined()
  })

  test('gpt-image-2-c contract accepts n > 1 (provider dispatches one call per image)', () => {
    const r = resolveContractParams(OPENAI_C, { n: 3 })
    // supportsN=false 表示单次请求 n 固定为 1；用户想要多张时由 Provider 逐张调度，
    // 不视为拒绝参数。
    expect(r.rejected.some(x => x.key === 'n')).toBe(false)
    expect(r.numImages).toBe(3)
  })

  test('quality accepted when in contract enum', () => {
    const r = resolveContractParams(OPENAI_GEN, { quality: 'medium' })
    expect(r.fields.quality).toBe('medium')
  })

  test('quality rejected when not in contract enum', () => {
    const r = resolveContractParams(OPENAI_GEN, { quality: 'ultra' })
    expect(r.rejected.some(x => x.key === 'quality')).toBe(true)
    expect(r.fields.quality).toBeUndefined()
  })
})

describe('resolveContractParams (OpenAI defaults)', () => {
  test('无参数 → 契约 supportsAuto=true 时使用 auto', () => {
    const r = resolveContractParams(OPENAI_GEN, {})
    expect(r.fields.size).toBe('auto')
    expect(r.rejected).toEqual([])
  })

  test('仅 resolution=2k → aspectRatio 补 1:1，落到 2048x2048', () => {
    const r = resolveContractParams(OPENAI_GEN, { resolution: '2k' })
    expect(r.fields.size).toBe('2048x2048')
    expect(r.rejected).toEqual([])
    expect(r.aspectRatio).toBe('1:1')
  })

  test('仅 aspectRatio=16:9 → 补最低支持等级（2K）', () => {
    const r = resolveContractParams(OPENAI_GEN, { aspectRatio: '16:9' })
    expect(r.fields.size).toBe('2048x1152')
    expect(r.resolution).toBe('2k')
  })
})

describe('resolveContractParams (Gemini)', () => {
  test('newapi 2.5: no imageSize emitted even when user provides', () => {
    const r = resolveContractParams(GEMINI_2_5, { imageSize: '1K', aspectRatio: '16:9' })
    expect(r.fields.imageSize).toBeUndefined()
    expect(r.fields.aspectRatio).toBe('16:9')
    expect(r.rejected.some(x => x.key === 'imageSize')).toBe(true)
  })

  test('newapi 3 Pro: 1K uppercase preserved even from lowercase input', () => {
    const r = resolveContractParams(GEMINI_3_PRO, { imageSize: '1k', aspectRatio: '9:16' })
    expect(r.fields.imageSize).toBe('1K')
    expect(r.fields.aspectRatio).toBe('9:16')
  })

  test('newapi 3 Pro edit contract does not emit imageConfig fields', () => {
    const r = resolveContractParams(GEMINI_3_PRO_EDIT, { imageSize: '1k', aspectRatio: '16:9' })
    expect(r.fields.imageSize).toBeUndefined()
    expect(r.fields.aspectRatio).toBeUndefined()
    expect(r.rejected.length).toBeGreaterThanOrEqual(1)
  })

  test('newapi 2.5 无参数 → 补默认 aspectRatio 1:1，但不发 imageSize', () => {
    const r = resolveContractParams(GEMINI_2_5, {})
    expect(r.fields.aspectRatio).toBe('1:1')
    expect(r.fields.imageSize).toBeUndefined()
    expect(r.rejected).toEqual([])
  })

  test('newapi 2.5 显式 -1k → 明确不支持，返回 rejected', () => {
    const r = resolveContractParams(GEMINI_2_5, { imageSize: '1k' })
    expect(r.rejected.some(x => x.key === 'imageSize')).toBe(true)
  })

  test('newapi 3 Pro 无参数 → 默认 aspectRatio 1:1 + imageSize 1K', () => {
    const r = resolveContractParams(GEMINI_3_PRO, {})
    expect(r.fields.aspectRatio).toBe('1:1')
    expect(r.fields.imageSize).toBe('1K')
  })

  test('newapi 3 Pro 只写比例 → 补 imageSize 1K', () => {
    const r = resolveContractParams(GEMINI_3_PRO, { aspectRatio: '16:9' })
    expect(r.fields.aspectRatio).toBe('16:9')
    expect(r.fields.imageSize).toBe('1K')
  })

  test('newapi 3 Pro 只写清晰度 → 补 aspectRatio 1:1', () => {
    const r = resolveContractParams(GEMINI_3_PRO, { imageSize: '2K' })
    expect(r.fields.imageSize).toBe('2K')
    expect(r.fields.aspectRatio).toBe('1:1')
  })

  test('newapi 3 Pro edit 用户未写尺寸 → 正常，不补 imageConfig 字段', () => {
    const r = resolveContractParams(GEMINI_3_PRO_EDIT, {})
    expect(r.fields.imageSize).toBeUndefined()
    expect(r.fields.aspectRatio).toBeUndefined()
    expect(r.rejected).toEqual([])
  })
})

describe('resolveContractParams (MJ)', () => {
  test('minimal: no ar/stylize → defaults --ar 1:1 and --stylize 100 auto-appended', () => {
    const r = resolveContractParams(MJ_IMAGINE, {})
    expect(r.fields.botType).toBe('MID_JOURNEY')
    expect(r.promptAppends).toContain('--ar 1:1')
    expect(r.promptAppends).toContain('--stylize 100')
  })

  test('aspectRatio adds --ar (and default --stylize 100 still auto-added)', () => {
    const r = resolveContractParams(MJ_IMAGINE, { aspectRatio: '16:9' })
    expect(r.promptAppends).toContain('--ar 16:9')
    expect(r.promptAppends).toContain('--stylize 100')
  })

  test('stylize adds --stylize (and default --ar 1:1 auto-added)', () => {
    const r = resolveContractParams(MJ_IMAGINE, { stylize: 250 })
    expect(r.promptAppends).toContain('--stylize 250')
    expect(r.promptAppends).toContain('--ar 1:1')
  })

  test('when prompt already contains --ar, resolver skips ar but still adds default stylize', () => {
    const r = resolveContractParams(MJ_IMAGINE, { aspectRatio: '16:9' }, { existingPrompt: 'cat --ar 1:1' })
    expect(r.promptAppends.some((a) => a.startsWith('--ar'))).toBe(false)
    expect(r.promptAppends).toContain('--stylize 100')
  })

  test('stylize duplicate detected via --s alias; default --ar still appended', () => {
    const r = resolveContractParams(MJ_IMAGINE, { stylize: 500 }, { existingPrompt: 'cat --s 100' })
    expect(r.promptAppends.some((a) => a.startsWith('--stylize'))).toBe(false)
    expect(r.promptAppends).toContain('--ar 1:1')
  })

  test('unsupported botType rejected', () => {
    const r = resolveContractParams(MJ_IMAGINE, { botType: 'NIJI_JOURNEY' })
    expect(r.rejected.some(x => x.key === 'botType')).toBe(true)
  })
})
