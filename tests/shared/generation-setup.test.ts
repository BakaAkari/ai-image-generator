/**
 * 生成请求上下文的公共层测试。
 *
 * 覆盖：所有入口（普通命令 / 向导 / ChatLuna bridge / YesImBot bridge）通过
 * `buildProtocolRequestContext` 得到一致的 requestContext + promptAdditions。
 */
import { describe, expect, test } from 'vitest'

import {
  applyPromptAppends,
  buildProtocolRequestContext,
} from '../../src/shared/generation-setup.js'

describe('buildProtocolRequestContext · 各入口共享', () => {
  test('openai 只传 aspectRatio → 分辨率补默认，n 补默认', () => {
    const out = buildProtocolRequestContext({
      protocol: 'openai',
      explicit: { aspectRatio: '16:9' },
      defaultNumImages: 1,
    })
    expect(out.requestContext.provider).toBe('openai')
    expect(out.requestContext.resolution).toBe('1k')
    expect(out.requestContext.aspectRatio).toBe('16:9')
    expect(out.requestContext.numImages).toBe(1)
    expect(out.promptAdditions).toEqual([])
  })

  test('openai 只传 resolution → 宽高比补默认 1:1', () => {
    const out = buildProtocolRequestContext({
      protocol: 'openai',
      explicit: { resolution: '4k' },
      defaultNumImages: 2,
    })
    expect(out.requestContext.resolution).toBe('4k')
    expect(out.requestContext.aspectRatio).toBe('1:1')
    expect(out.requestContext.numImages).toBe(2)
  })

  test('openai 什么都不传 → 全部默认', () => {
    const out = buildProtocolRequestContext({
      protocol: 'openai',
      explicit: {},
    })
    expect(out.requestContext.resolution).toBe('1k')
    expect(out.requestContext.aspectRatio).toBe('1:1')
    expect(out.requestContext.numImages).toBe(1)
  })

  test('gemini 大写 1K 与小写 1k 结果一致', () => {
    const lower = buildProtocolRequestContext({
      protocol: 'gemini',
      explicit: { resolution: '1k' },
    })
    const upper = buildProtocolRequestContext({
      protocol: 'gemini',
      explicit: { imageSize: '1K' },
    })
    expect(lower.requestContext.resolution).toBe('1k')
    expect(upper.requestContext.resolution).toBe('1k')
    expect(lower.requestContext.aspectRatio).toBe('1:1')
  })

  test('mj 走 promptAppends，不写入 requestContext.resolution', () => {
    const out = buildProtocolRequestContext({
      protocol: 'mj',
      explicit: { aspectRatio: '16:9', stylize: 250 },
    })
    expect(out.requestContext.resolution).toBeUndefined()
    expect(out.requestContext.aspectRatio).toBeUndefined()
    expect(out.requestContext.promptAppends).toEqual(['--ar 16:9', '--stylize 250'])
    expect(out.promptAdditions).toEqual(['--ar 16:9', '--stylize 250'])
  })

  test('mj 已含 --ar 的 prompt → 只补 --stylize', () => {
    const out = buildProtocolRequestContext({
      protocol: 'mj',
      explicit: {},
      existingPrompt: 'a cat --ar 4:3',
    })
    expect(out.promptAdditions.some(s => s.startsWith('--ar'))).toBe(false)
    expect(out.promptAdditions).toContain('--stylize 100')
  })

  test('openai 自定义分辨率 1024x2048 透传到 requestContext（回归测试）', () => {
    const out = buildProtocolRequestContext({
      protocol: 'openai',
      explicit: { resolution: '1024x2048' },
    })
    expect(out.requestContext.resolution).toBe('1024x2048')
    // 宽高比仍应补协议默认
    expect(out.requestContext.aspectRatio).toBe('1:1')
    expect(out.known).toBe(true)
  })

  test('gemini 不接收 openai 风格的自定义分辨率', () => {
    const out = buildProtocolRequestContext({
      protocol: 'gemini',
      explicit: { resolution: '1024x2048' },
    })
    expect(out.requestContext.resolution).toBeUndefined()
    expect(out.requestContext.aspectRatio).toBe('1:1')
  })

  test('openai 显式 3:2 → requestContext.aspectRatio 保留，resolution 补默认（回归）', () => {
    const out = buildProtocolRequestContext({
      protocol: 'openai',
      explicit: { aspectRatio: '3:2' },
    })
    expect(out.requestContext.aspectRatio).toBe('3:2')
    expect(out.requestContext.resolution).toBe('1k')
    expect(out.known).toBe(true)
  })

  test('openai 显式 2:3 → requestContext.aspectRatio 保留，resolution 补默认（回归）', () => {
    const out = buildProtocolRequestContext({
      protocol: 'openai',
      explicit: { aspectRatio: '2:3' },
    })
    expect(out.requestContext.aspectRatio).toBe('2:3')
    expect(out.requestContext.resolution).toBe('1k')
  })

  test('gemini 显式 3:2 → requestContext.aspectRatio 保留，imageSize 补默认（回归）', () => {
    const out = buildProtocolRequestContext({
      protocol: 'gemini',
      explicit: { aspectRatio: '3:2' },
    })
    expect(out.requestContext.aspectRatio).toBe('3:2')
    expect(out.requestContext.resolution).toBe('1k')
  })

  test('gemini 显式 2:3 → requestContext.aspectRatio 保留，imageSize 补默认（回归）', () => {
    const out = buildProtocolRequestContext({
      protocol: 'gemini',
      explicit: { aspectRatio: '2:3' },
    })
    expect(out.requestContext.aspectRatio).toBe('2:3')
    expect(out.requestContext.resolution).toBe('1k')
  })

  test('mj 显式 3:2 → promptAppends 生成 --ar 3:2，stylize 补默认（回归）', () => {
    const out = buildProtocolRequestContext({
      protocol: 'mj',
      explicit: { aspectRatio: '3:2' },
    })
    expect(out.requestContext.aspectRatio).toBeUndefined()
    expect(out.requestContext.promptAppends).toContain('--ar 3:2')
    expect(out.requestContext.promptAppends).toContain('--stylize 100')
    expect(out.promptAdditions).toContain('--ar 3:2')
  })

  test('mj 显式 2:3 → promptAppends 生成 --ar 2:3，stylize 补默认（回归）', () => {
    const out = buildProtocolRequestContext({
      protocol: 'mj',
      explicit: { aspectRatio: '2:3' },
    })
    expect(out.requestContext.promptAppends).toContain('--ar 2:3')
    expect(out.requestContext.promptAppends).toContain('--stylize 100')
    expect(out.promptAdditions).toContain('--ar 2:3')
  })

  test('未知协议：conservative — 不产出 params/promptAdditions，但 numImages 可用', () => {
    const out = buildProtocolRequestContext({
      protocol: 'flux',
      explicit: { resolution: '2k', aspectRatio: '16:9', numImages: 2 },
    })
    expect(out.requestContext.resolution).toBeUndefined()
    expect(out.requestContext.aspectRatio).toBeUndefined()
    expect(out.requestContext.numImages).toBe(2)
    expect(out.promptAdditions).toEqual([])
    expect(out.known).toBe(false)
  })

  test('modelMapping 元数据写入 requestContext', () => {
    const out = buildProtocolRequestContext({
      protocol: 'openai',
      supplier: 'openai-compatible',
      modelMapping: { suffix: 'gpt', modelId: 'gpt-image-1' } as any,
      routeId: 'openai/gpt-image-1',
      explicit: {},
    })
    expect(out.requestContext.supplier).toBe('openai-compatible')
    expect(out.requestContext.provider).toBe('openai')
    expect(out.requestContext.modelId).toBe('gpt-image-1')
    expect(out.requestContext.modelSuffix).toBe('gpt')
    expect(out.requestContext.routeId).toBe('openai/gpt-image-1')
  })
})

describe('buildProtocolRequestContext · bridge parity（ChatLuna vs YesImBot）', () => {
  /**
   * 两个 bridge 都通过 `buildProtocolRequestContext` 构建 requestContext。
   * 这里用两组等价入参模拟两个 bridge 的调用形态，断言结果一致。
   */
  const chatlunaInput = {
    protocol: 'openai',
    modelMapping: { suffix: 'gpt', modelId: 'gpt-image-1', supplier: 'openai-compatible' } as any,
    supplier: 'openai-compatible' as const,
    explicit: {
      resolution: '2k',
      aspectRatio: '16:9',
      numImages: 3,
    },
    defaultNumImages: 3,
  }
  const yesimbotInput = { ...chatlunaInput }

  test('相同显式入参 → 相同 requestContext', () => {
    const a = buildProtocolRequestContext(chatlunaInput)
    const b = buildProtocolRequestContext(yesimbotInput)
    expect(a.requestContext).toEqual(b.requestContext)
    expect(a.promptAdditions).toEqual(b.promptAdditions)
    expect(a.numImages).toEqual(b.numImages)
  })

  test('两个 bridge 都对未指定分辨率补默认（openai）', () => {
    const a = buildProtocolRequestContext({
      protocol: 'openai',
      explicit: { aspectRatio: '16:9' },
      defaultNumImages: 1,
    })
    const b = buildProtocolRequestContext({
      protocol: 'openai',
      explicit: { aspectRatio: '16:9' },
      defaultNumImages: 1,
    })
    expect(a.requestContext.resolution).toBe('1k')
    expect(b.requestContext.resolution).toBe('1k')
  })

  test('两个 bridge 对 MJ 输出同一份 promptAppends（去重一致）', () => {
    const a = buildProtocolRequestContext({
      protocol: 'mj',
      explicit: { aspectRatio: '16:9' },
    })
    const b = buildProtocolRequestContext({
      protocol: 'mj',
      explicit: { aspectRatio: '16:9' },
    })
    expect(a.promptAdditions).toEqual(b.promptAdditions)
  })
})

describe('applyPromptAppends', () => {
  test('empty appends returns original prompt', () => {
    expect(applyPromptAppends('cat', [])).toBe('cat')
    expect(applyPromptAppends('cat', undefined)).toBe('cat')
  })

  test('appends joined with spaces', () => {
    expect(applyPromptAppends('cat', ['--ar 16:9', '--stylize 100'])).toBe('cat --ar 16:9 --stylize 100')
  })

  test('empty prompt yields just the suffix', () => {
    expect(applyPromptAppends('', ['--ar 1:1'])).toBe('--ar 1:1')
    expect(applyPromptAppends(undefined, ['--ar 1:1'])).toBe('--ar 1:1')
  })

  test('trailing space in prompt is not doubled', () => {
    expect(applyPromptAppends('cat ', ['--ar 1:1'])).toBe('cat --ar 1:1')
  })

  test('base 已含 --ar → 仅丢弃 --ar，保留 --stylize', () => {
    const out = applyPromptAppends('a cat --ar 4:3', ['--ar 1:1', '--stylize 100'])
    expect(out).toBe('a cat --ar 4:3 --stylize 100')
  })

  test('base 已含 --stylize → 仅丢弃 --stylize，保留 --ar', () => {
    const out = applyPromptAppends('a cat --stylize 200', ['--ar 1:1', '--stylize 100'])
    expect(out).toBe('a cat --stylize 200 --ar 1:1')
  })

  test('base 已含 --s 别名 → 视为 stylize 同类别，仅丢弃 --stylize', () => {
    const out = applyPromptAppends('a cat --s 250', ['--ar 1:1', '--stylize 100'])
    expect(out).toBe('a cat --s 250 --ar 1:1')
  })

  test('base 同时含 --ar 与 --stylize → 全部丢弃', () => {
    const out = applyPromptAppends(
      'a cat --ar 4:3 --stylize 200',
      ['--ar 1:1', '--stylize 100'],
    )
    expect(out).toBe('a cat --ar 4:3 --stylize 200')
  })

  test('重复调用两次结果不变（幂等）', () => {
    const first = applyPromptAppends('a cat', ['--ar 1:1', '--stylize 100'])
    expect(first).toBe('a cat --ar 1:1 --stylize 100')
    const second = applyPromptAppends(first, ['--ar 1:1', '--stylize 100'])
    expect(second).toBe(first)
    const third = applyPromptAppends(second, ['--ar 16:9', '--stylize 500'])
    // 已存在同类别 flag，即便值不同也不重复追加
    expect(third).toBe(first)
  })

  test('两个类别互不影响：base 有 --ar 4:3 时依然可加 --stylize 250', () => {
    const out = applyPromptAppends('cat --ar 4:3', ['--stylize 250'])
    expect(out).toBe('cat --ar 4:3 --stylize 250')
  })
})
