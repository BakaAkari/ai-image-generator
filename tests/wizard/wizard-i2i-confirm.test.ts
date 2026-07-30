/**
 * wizard-handler.ts 图生图向导链路回归。
 *
 * 覆盖：
 * - Bug 1：向导分步收集的 internal: 图片 URL 在「确认」后原样透传给编排器
 *   （此前编排器侧白名单会丢弃 internal: 字符串，误报「请在 240 秒内发送 1 张图片」）。
 * - Bug 3.1：图生图带图无描述时提示「请输入修改描述」（而非文生图文案）。
 * - Bug 3.2：model-select / confirm 等后续步骤收到图片时更新图片并重新渲染，不再静默吞掉。
 * - Bug 3.5：确认路径传 includeQuote=false，忽略「确认」消息引用的无关图片。
 */
import { describe, expect, test, vi } from 'vitest'

vi.mock('koishi', () => {
  const parse = (raw: string) => {
    const s = typeof raw === 'string' ? raw : ''
    const elements: any[] = []
    const imgRe = /<img\b[^>]*src="([^"]*)"[^>]*\/?>/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = imgRe.exec(s))) {
      const before = s.slice(last, m.index)
      if (before) elements.push({ type: 'text', attrs: { content: before }, children: [] })
      elements.push({ type: 'img', attrs: { src: m[1] }, children: [] })
      last = m.index + m[0].length
    }
    const rest = s.slice(last)
    if (rest) elements.push({ type: 'text', attrs: { content: rest }, children: [] })
    return elements
  }
  const select = (elements: any[], selector: string) =>
    Array.isArray(elements) ? elements.filter((el) => el?.type === selector) : []
  return { Argv: class {}, h: { parse, select }, Schema: class {} }
})

import { createWizardHandler } from '../../src/wizard/wizard-handler.js'
import { WizardSessionManager } from '../../src/services/wizard-session.js'
import type { WizardHandler } from '../../src/wizard/wizard-handler.js'

const INTERNAL_IMG = 'internal:lark/self123/im/v1/messages/m1/resources/k1?type=image'
const INTERNAL_IMG_2 = 'internal:lark/self123/im/v1/messages/m2/resources/k2?type=image'

function makeSession(content: string, overrides: Record<string, any> = {}) {
  return {
    userId: 'u1',
    username: 'user',
    platform: 'lark',
    isDirect: true,
    content,
    quote: undefined,
    ...overrides,
  } as any
}

function makeArgv(session: any) {
  return { session, args: [], options: {}, rest: '' } as any
}

function setup() {
  const wizardSessions = new WizardSessionManager()
  const config = {
    modelMappings: [{ suffix: 'gpt', modelId: 'gpt-image-1' }],
    defaultNumImages: 1,
  } as any
  const calls: { type: string; args: any[] }[] = []
  const handlers = {
    executeTextToImage: (...args: any[]) => { calls.push({ type: 't2i', args }); return Promise.resolve('t2i') },
    executeImageToImage: (...args: any[]) => { calls.push({ type: 'i2i', args }); return Promise.resolve('i2i') },
    executeComposeImage: (...args: any[]) => { calls.push({ type: 'compose', args }); return Promise.resolve('compose') },
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
    wizardSessions,
  })
  return { handler, wizardSessions, calls }
}

/** 走完 图生图 向导到 confirm 步骤（分步：先图 → 描述 → 模型 → 参数跳过） */
async function walkToConfirm(handler: WizardHandler) {
  const next = vi.fn()
  const mw = handler.getMiddleware()

  const r1 = await handler.handleCommand(makeSession('图生图'), '图生图', makeArgv(makeSession('图生图')), undefined, undefined)
  expect(r1).toBe('请先发送 1 张图片')

  const r2 = await mw(makeSession(`<img src="${INTERNAL_IMG}"/>`), next)
  expect(r2).toBe('请输入修改描述')

  const r3 = await mw(makeSession('把背景换成蓝色'), next)
  expect(String(r3)).toContain('1 ·') // 模型列表

  const r4 = await mw(makeSession('1'), next)
  expect(String(r4)).toContain('参数设置')

  const r5 = await mw(makeSession('跳过'), next)
  expect(String(r5)).toContain('确认生成')

  return { mw, next }
}

describe('图生图向导 → 确认生成链路', () => {
  test('分步收图后「确认」：internal: 图片原样透传，includeQuote=false（Bug 1 / 3.5 回归）', async () => {
    const { handler, calls } = setup()
    const { mw, next } = await walkToConfirm(handler)

    // 「确认」消息引用了一张无关图片 —— 不应混入
    const confirmSession = makeSession('确认', {
      quote: { elements: [{ type: 'img', attrs: { src: 'internal:lark/unrelated/9' } }] },
    })
    const r = await mw(confirmSession, next)

    expect(r).toBe('i2i')
    expect(calls).toHaveLength(1)
    const { args } = calls[0]
    expect(args[1]).toBe(INTERNAL_IMG) // imgParam 为向导收集的 internal: URL
    expect(args[2]).toBe('把背景换成蓝色')
    expect(args[7]).toEqual({ includeQuote: false })
    expect(next).not.toHaveBeenCalled()
  })

  test('后续步骤收到图片：更新图片并重新渲染，不再静默吞掉（Bug 3.2）', async () => {
    const { handler, calls } = setup()
    const { mw, next } = await walkToConfirm(handler)

    // confirm 步骤补发/更换图片
    const r = await mw(makeSession(`<img src="${INTERNAL_IMG_2}"/>`), next)
    expect(String(r)).toContain('已更新图片')
    expect(String(r)).toContain('确认生成')

    await mw(makeSession('确认'), next)
    expect(calls).toHaveLength(1)
    expect(calls[0].args[1]).toBe(INTERNAL_IMG_2) // 用的是更换后的图片
  })

  test('带图命令但无描述：提示「请输入修改描述」（Bug 3.1）', async () => {
    const { handler } = setup()
    const session = makeSession(`图生图 <img src="${INTERNAL_IMG}"/>`)
    const r = await handler.handleCommand(session, '图生图', makeArgv(session), undefined, undefined)
    expect(r).toBe('请输入修改描述')
  })
})
