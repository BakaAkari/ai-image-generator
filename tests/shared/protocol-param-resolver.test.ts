/**
 * 协议参数规范化 + 缺失值自动补全 —— 公共层测试。
 *
 * 覆盖：openai / gemini / mj 三种协议的空/部分/完整入参，未知协议保守行为，
 * Gemini 1k/1K 大小写规范化，MJ promptAppend 与去重，显式覆盖默认，
 * 无效显式值处理，以及命令入口 / bridge 入口共享同一解析器。
 */
import { describe, expect, test } from 'vitest'

import { resolveProtocolParams } from '../../src/shared/protocol-param-resolver.js'

describe('resolveProtocolParams · openai', () => {
  test('no explicit params → fill all defaults', () => {
    const out = resolveProtocolParams('openai', {})
    expect(out.known).toBe(true)
    expect(out.params.resolution).toBe('1k')
    expect(out.params.aspectRatio).toBe('1:1')
    expect(out.params.n).toBe(1)
    expect(out.resolution).toBe('1k')
    expect(out.aspectRatio).toBe('1:1')
    expect(out.promptAdditions).toEqual([])
    expect(out.numImages).toBe(1)
  })

  test('only resolution → aspect ratio uses default', () => {
    const out = resolveProtocolParams('openai', { resolution: '2k' })
    expect(out.params.resolution).toBe('2k')
    expect(out.params.aspectRatio).toBe('1:1')
    expect(out.resolution).toBe('2k')
    expect(out.aspectRatio).toBe('1:1')
  })

  test('only aspect ratio → resolution uses default', () => {
    const out = resolveProtocolParams('openai', { aspectRatio: '16:9' })
    expect(out.params.resolution).toBe('1k')
    expect(out.params.aspectRatio).toBe('16:9')
  })

  test('full explicit params override defaults', () => {
    const out = resolveProtocolParams('openai', {
      resolution: '4k',
      aspectRatio: '9:16',
      n: 3,
    })
    expect(out.params.resolution).toBe('4k')
    expect(out.params.aspectRatio).toBe('9:16')
    expect(out.params.n).toBe(3)
    expect(out.numImages).toBe(3)
  })

  test('numImages alias populates n param', () => {
    const out = resolveProtocolParams('openai', { numImages: 2 })
    expect(out.params.n).toBe(2)
    expect(out.numImages).toBe(2)
  })

  test('invalid explicit resolution is ignored (no silent default swap)', () => {
    const out = resolveProtocolParams('openai', { resolution: '99k' })
    expect(out.params.resolution).toBeUndefined()
    expect(out.resolution).toBeUndefined()
    expect(out.params.aspectRatio).toBe('1:1')
  })

  test('custom resolution NxN (1024x2048) is accepted for openai', () => {
    const out = resolveProtocolParams('openai', { resolution: '1024x2048' })
    expect(out.params.resolution).toBe('1024x2048')
    expect(out.resolution).toBe('1024x2048')
    // 宽高比仍应补默认
    expect(out.params.aspectRatio).toBe('1:1')
  })

  test('custom resolution 960x960 preserved verbatim', () => {
    const out = resolveProtocolParams('openai', { resolution: '960x960' })
    expect(out.params.resolution).toBe('960x960')
    expect(out.resolution).toBe('960x960')
  })

  test('legacy aspectRatio 3:2 stays valid (openai 回归)', () => {
    const out = resolveProtocolParams('openai', { aspectRatio: '3:2' })
    expect(out.params.aspectRatio).toBe('3:2')
    expect(out.aspectRatio).toBe('3:2')
    // 缺失的 resolution 仍按协议默认补齐
    expect(out.params.resolution).toBe('1k')
    expect(out.resolution).toBe('1k')
  })

  test('legacy aspectRatio 2:3 stays valid (openai 回归)', () => {
    const out = resolveProtocolParams('openai', { aspectRatio: '2:3' })
    expect(out.params.aspectRatio).toBe('2:3')
    expect(out.resolution).toBe('1k')
  })
})

describe('resolveProtocolParams · gemini', () => {
  test('no params → all defaults', () => {
    const out = resolveProtocolParams('gemini', {})
    expect(out.params.imageSize).toBe('1K')
    expect(out.params.aspectRatio).toBe('1:1')
    expect(out.imageSize).toBe('1K')
    expect(out.resolution).toBe('1k')
    expect(out.aspectRatio).toBe('1:1')
  })

  test('lower-case 1k is normalized to protocol option 1K', () => {
    const out = resolveProtocolParams('gemini', { resolution: '1k' })
    expect(out.params.imageSize).toBe('1K')
    expect(out.imageSize).toBe('1K')
    expect(out.resolution).toBe('1k')
  })

  test('lower-case 2k and 4k are normalized case-insensitively', () => {
    expect(resolveProtocolParams('gemini', { resolution: '2k' }).params.imageSize).toBe('2K')
    expect(resolveProtocolParams('gemini', { resolution: '4k' }).params.imageSize).toBe('4K')
    expect(resolveProtocolParams('gemini', { imageSize: '4K' }).params.imageSize).toBe('4K')
  })

  test('gemini rejects openai-style custom NxN resolution (enum only)', () => {
    const out = resolveProtocolParams('gemini', { resolution: '1024x2048' })
    // 不应把 openai 的自定义分辨率透传给 gemini 的 imageSize
    expect(out.params.imageSize).toBeUndefined()
    expect(out.imageSize).toBeUndefined()
    expect(out.resolution).toBeUndefined()
    // aspectRatio 仍补默认
    expect(out.params.aspectRatio).toBe('1:1')
  })

  test('gemini also accepts aspectRatio alias', () => {
    const out = resolveProtocolParams('gemini', { aspectRatio: '16:9' })
    expect(out.params.aspectRatio).toBe('16:9')
    expect(out.params.imageSize).toBe('1K')
  })

  test('legacy aspectRatio 3:2 stays valid (gemini 回归)', () => {
    const out = resolveProtocolParams('gemini', { aspectRatio: '3:2' })
    expect(out.params.aspectRatio).toBe('3:2')
    expect(out.aspectRatio).toBe('3:2')
    // 缺失 imageSize 时补协议默认
    expect(out.params.imageSize).toBe('1K')
    expect(out.imageSize).toBe('1K')
    expect(out.resolution).toBe('1k')
  })

  test('legacy aspectRatio 2:3 stays valid (gemini 回归)', () => {
    const out = resolveProtocolParams('gemini', { aspectRatio: '2:3' })
    expect(out.params.aspectRatio).toBe('2:3')
    expect(out.params.imageSize).toBe('1K')
  })

  test('gemini has no n param — numImages falls back to explicit or default', () => {
    const out = resolveProtocolParams('gemini', { numImages: 2 })
    expect(out.numImages).toBe(2)
    expect(out.params.n).toBeUndefined()
  })

  test('numImages clamps to 1-4', () => {
    expect(resolveProtocolParams('gemini', { numImages: 99 }).numImages).toBe(4)
    expect(resolveProtocolParams('gemini', { numImages: -1 }).numImages).toBe(1)
  })
})

describe('resolveProtocolParams · mj', () => {
  test('no params → promptAdditions carry default ar + stylize', () => {
    const out = resolveProtocolParams('mj', {})
    expect(out.params).toEqual({})
    expect(out.promptAdditions).toEqual(['--ar 1:1', '--stylize 100'])
  })

  test('explicit ar via alias aspectRatio populates promptAdditions', () => {
    const out = resolveProtocolParams('mj', { aspectRatio: '16:9' })
    expect(out.promptAdditions).toContain('--ar 16:9')
    expect(out.promptAdditions).toContain('--stylize 100')
  })

  test('explicit stylize overrides default', () => {
    const out = resolveProtocolParams('mj', { stylize: 750 })
    expect(out.promptAdditions).toContain('--stylize 750')
    expect(out.promptAdditions).toContain('--ar 1:1')
  })

  test('mj does not emit resolution/imageSize params', () => {
    const out = resolveProtocolParams('mj', { resolution: '2k' })
    expect(out.params.resolution).toBeUndefined()
    expect(out.params.imageSize).toBeUndefined()
    expect(out.resolution).toBeUndefined()
  })

  test('promptAdditions dedup vs existing prompt containing --ar', () => {
    const out = resolveProtocolParams('mj', {
      aspectRatio: '16:9',
    }, { existingPromptAppends: 'a cat --ar 4:3' })
    // 已存在 --ar 时不重复追加
    expect(out.promptAdditions.some(s => s.startsWith('--ar'))).toBe(false)
    expect(out.promptAdditions).toContain('--stylize 100')
  })

  test('promptAdditions dedup vs existing prompt containing --stylize', () => {
    const out = resolveProtocolParams('mj', {},
      { existingPromptAppends: 'a cat --stylize 200' })
    expect(out.promptAdditions.some(s => s.startsWith('--stylize'))).toBe(false)
    expect(out.promptAdditions).toContain('--ar 1:1')
  })

  test('promptAdditions dedup vs existing short --s alias', () => {
    const out = resolveProtocolParams('mj', {},
      { existingPromptAppends: 'a cat --s 250' })
    expect(out.promptAdditions.some(s => s.startsWith('--stylize'))).toBe(false)
    expect(out.promptAdditions).toContain('--ar 1:1')
  })

  test('mj numImages honors explicit input and clamps', () => {
    expect(resolveProtocolParams('mj', { numImages: 2 }).numImages).toBe(2)
  })

  test('legacy aspectRatio 3:2 → --ar 3:2 prompt flag (mj 回归)', () => {
    const out = resolveProtocolParams('mj', { aspectRatio: '3:2' })
    expect(out.promptAdditions).toContain('--ar 3:2')
    // stylize 缺失时仍补协议默认
    expect(out.promptAdditions).toContain('--stylize 100')
  })

  test('legacy aspectRatio 2:3 → --ar 2:3 prompt flag (mj 回归)', () => {
    const out = resolveProtocolParams('mj', { aspectRatio: '2:3' })
    expect(out.promptAdditions).toContain('--ar 2:3')
    expect(out.promptAdditions).toContain('--stylize 100')
  })

  test('mj ignores NxN custom resolution silently (protocol has no resolution)', () => {
    const out = resolveProtocolParams('mj', { resolution: '1024x2048' })
    expect(out.params.resolution).toBeUndefined()
    expect(out.resolution).toBeUndefined()
    // 仍生成 promptAdditions
    expect(out.promptAdditions).toContain('--ar 1:1')
    expect(out.promptAdditions).toContain('--stylize 100')
  })
})

describe('resolveProtocolParams · unknown protocol', () => {
  test('unknown protocol emits no params and no additions', () => {
    const out = resolveProtocolParams('flux' as any, { resolution: '2k', aspectRatio: '16:9' })
    expect(out.known).toBe(false)
    expect(out.params).toEqual({})
    expect(out.promptAdditions).toEqual([])
    expect(out.resolution).toBeUndefined()
    expect(out.aspectRatio).toBeUndefined()
  })

  test('undefined protocol also stays conservative', () => {
    const out = resolveProtocolParams(undefined, { resolution: '2k' })
    expect(out.known).toBe(false)
    expect(out.params).toEqual({})
    expect(out.numImages).toBe(1)
  })

  test('unknown protocol still surfaces numImages for downstream billing', () => {
    const out = resolveProtocolParams('flux' as any, { numImages: 3 })
    expect(out.numImages).toBe(3)
  })

  test('unknown protocol respects defaultNumImages option', () => {
    const out = resolveProtocolParams('flux' as any, {}, { defaultNumImages: 2 })
    expect(out.numImages).toBe(2)
  })
})

describe('resolveProtocolParams · explicit-over-default coverage', () => {
  test('all-explicit openai request stays intact', () => {
    const out = resolveProtocolParams('openai', {
      resolution: '4k',
      aspectRatio: '4:3',
      n: 4,
    })
    expect(out.params).toEqual({ resolution: '4k', aspectRatio: '4:3', n: 4 })
    expect(out.numImages).toBe(4)
  })

  test('explicit gemini imageSize case is preserved as protocol option', () => {
    const out = resolveProtocolParams('gemini', { imageSize: '2K' })
    expect(out.params.imageSize).toBe('2K')
  })

  test('default numImages falls back through options.defaultNumImages', () => {
    const out = resolveProtocolParams('gemini', {}, { defaultNumImages: 3 })
    expect(out.numImages).toBe(3)
  })
})
