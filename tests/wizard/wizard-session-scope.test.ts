/**
 * 向导会话作用域与超时回归（第三批，Bug 3.3 + 「跟账户走」设计）。
 *
 * - 会话键为 platform:userId —— 「跟账户走」（用户明确的设计决策）：
 *   每个用户全局有且仅有一条图像生成链路，跨频道共享同一条向导，
 *   重复发起报冲突，「取消」全局生效。
 * - Bug 3.3：每步超时由配置驱动（apiTimeout）；超时回收后用户下一次发消息时
 *   收到一次「已超时退出」提醒，且该消息正常放行。
 */
import { describe, expect, test, vi } from 'vitest'

vi.mock('koishi', () => {
  const parse = (raw: string) => {
    const s = typeof raw === 'string' ? raw : ''
    return s ? [{ type: 'text', attrs: { content: s }, children: [] }] : []
  }
  const select = (elements: any[], selector: string) =>
    Array.isArray(elements) ? elements.filter((el) => el?.type === selector) : []
  return { Argv: class {}, h: { parse, select }, Schema: class {} }
})

import { createWizardHandler } from '../../src/wizard/wizard-handler.js'
import { WizardSessionManager } from '../../src/services/wizard-session.js'

function makeSession(content: string, overrides: Record<string, any> = {}) {
  return {
    userId: 'u1',
    username: 'user',
    platform: 'lark',
    channelId: 'ch-a',
    isDirect: false,
    content,
    quote: undefined,
    send: vi.fn(),
    ...overrides,
  } as any
}

function makeArgv(session: any) {
  // 模拟真实命令 action：argv 存在但无行内 prompt/图片
  return { session, args: [], options: {}, rest: '' } as any
}

function setup(timeoutMs = 120_000) {
  const sessions = new WizardSessionManager(() => timeoutMs)
  const config = {
    modelMappings: [{ suffix: 'gpt', modelId: 'gpt-image-1' }],
    defaultNumImages: 1,
  } as any
  const handlers = {
    executeTextToImage: () => Promise.resolve('t2i'),
    executeImageToImage: () => Promise.resolve('i2i'),
    executeComposeImage: () => Promise.resolve('compose'),
  }
  const service = {
    checkModelAccess: () => ({ allowed: true }),
    checkFreeTrialForModel: () => ({ allowed: true }),
    isFreePlatform: () => true,
    getStylePreset: () => undefined,
    listStylePresets: () => [],
    resolveContractForMapping: () => undefined,
    formatCredits: (n: number) => `${n}`,
  } as any
  const handler = createWizardHandler({
    ctx: { logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) } as any,
    catalog: { current: null },
    service,
    handlers: handlers as any,
    getConfig: () => config,
    wizardSessions: sessions,
  })
  return { handler, sessions }
}

describe('向导会话键（「跟账户走」，用户级唯一链路）', () => {
  test('同一用户跨频道共享唯一向导：B 频道消息驱动同一向导，重复发起报冲突', async () => {
    const { handler } = setup()
    const next = vi.fn()
    const mw = handler.getMiddleware()

    // A 频道启动向导
    const r1 = await handler.handleCommand(makeSession('文生图'), '文生图', makeArgv(makeSession('文生图')), undefined, undefined)
    expect(r1).toBe('请发送画面描述')

    // B 频道发消息 → 驱动同一条向导（进入模型列表），不被放行
    const rB = await mw(makeSession('一只猫', { channelId: 'ch-b' }), next)
    expect(next).not.toHaveBeenCalled()
    expect(String(rB)).toContain('1 ·')

    // B 频道重复发起 → 冲突（全局唯一链路，防并发调用）
    const r2 = await handler.handleCommand(makeSession('文生图', { channelId: 'ch-b' }), '文生图', makeArgv(makeSession('文生图', { channelId: 'ch-b' })), undefined, undefined)
    expect(String(r2)).toContain('已有进行中的生成向导')
  })

  test('同一频道内仍有单会话冲突保护', async () => {
    const { handler } = setup()
    const r1 = await handler.handleCommand(makeSession('文生图'), '文生图', makeArgv(makeSession('文生图')), undefined, undefined)
    expect(r1).toBe('请发送画面描述')
    const r2 = await handler.handleCommand(makeSession('文生图'), '文生图', makeArgv(makeSession('文生图')), undefined, undefined)
    expect(String(r2)).toContain('已有进行中的生成向导')
  })

  test('「取消」全局生效：在任意频道取消唯一的向导', async () => {
    const { handler } = setup()
    const next = vi.fn()
    const mw = handler.getMiddleware()

    await handler.handleCommand(makeSession('文生图'), '文生图', makeArgv(makeSession('文生图')), undefined, undefined)

    // 在 B 频道取消 A 频道启动的向导
    const r = await mw(makeSession('取消', { channelId: 'ch-b' }), next)
    expect(r).toBe('已退出生成向导')

    // 向导已全局退出：消息完全放行
    const r2 = await mw(makeSession('一只猫', { channelId: 'ch-a' }), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(r2).toBeUndefined()

    // 可以重新发起
    const r3 = await handler.handleCommand(makeSession('文生图'), '文生图', makeArgv(makeSession('文生图')), undefined, undefined)
    expect(r3).toBe('请发送画面描述')
  })
})

describe('向导超时（Bug 3.3）', () => {
  test('每步超时由配置驱动：超时后 get 回收，未超时可获取', async () => {
    const sessions = new WizardSessionManager(() => 1000)
    const started = sessions.start('lark:u1', 'u1', 'user', 'text-to-image')
    expect('conflict' in started).toBe(false)
    const w = started as any

    w.lastActivityAt = Date.now() - 500
    expect(sessions.get('lark:u1')).toBeDefined()

    w.lastActivityAt = Date.now() - 1500
    expect(sessions.get('lark:u1')).toBeUndefined()
  })

  test('超时后第一次发消息：收到一次提醒且消息放行，之后不再提醒', async () => {
    const { handler, sessions } = setup(1000)
    const next = vi.fn()
    const mw = handler.getMiddleware()

    await handler.handleCommand(makeSession('文生图'), '文生图', makeArgv(makeSession('文生图')), undefined, undefined)
    const w = sessions.get('lark:u1')!
    w.lastActivityAt = Date.now() - 1500 // 强制过期

    const msg = makeSession('文生图 一只猫')
    const r = await mw(msg, next)
    expect(next).toHaveBeenCalledTimes(1) // 消息放行（新指令可正常执行）
    expect(r).toBeUndefined()
    expect(msg.send).toHaveBeenCalledWith('之前的生成向导已超时退出，请重新发起指令')

    // 第二次发消息：会话已回收，不再提醒
    const msg2 = makeSession('hello')
    await mw(msg2, next)
    expect(msg2.send).not.toHaveBeenCalled()
  })

  test('未超时时不触发提醒', async () => {
    const { handler } = setup(1000)
    const next = vi.fn()
    const mw = handler.getMiddleware()

    await handler.handleCommand(makeSession('文生图'), '文生图', makeArgv(makeSession('文生图')), undefined, undefined)
    const msg = makeSession('一只猫')
    const r = await mw(msg, next)
    expect(String(r)).toContain('1 ·')
    expect(msg.send).not.toHaveBeenCalled()
  })
})
