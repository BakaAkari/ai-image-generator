/**
 * wizard-handler.ts 合成图（compose-image）向导链路回归（第二批，Bug 4）。
 *
 * 此前 `合成图` 在 guided 模式下被当成文生图（不收图、最终走 executeTextToImage）。
 * 本测试覆盖：多图跨消息累计 → 合成描述 → 选模型 → 参数 → 确认 → executeComposeImage。
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

const IMG_1 = 'internal:lark/self/im/v1/messages/m1/resources/k1?type=image'
const IMG_2 = 'internal:lark/self/im/v1/messages/m2/resources/k2?type=image'
const IMG_3 = 'internal:lark/self/im/v1/messages/m3/resources/k3?type=image'

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
  const sessions = new WizardSessionManager()
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
    wizardSessions: sessions,
  })
  return { handler, calls }
}

describe('合成图向导（Bug 4）', () => {
  test('跨消息累计 2 图 + 描述 → 选模型 → 确认 → executeComposeImage（不再错走文生图）', async () => {
    const { handler, calls } = setup()
    const next = vi.fn()
    const mw = handler.getMiddleware()

    const cmdSession = makeSession('合成图')
    const r1 = await handler.handleCommand(cmdSession, '合成图', makeArgv(cmdSession), undefined, undefined)
    expect(r1).toBe('请发送至少 2 张图片（2-8 张）')

    const r2 = await mw(makeSession(`<img src="${IMG_1}"/>`), next)
    expect(String(r2)).toContain('已收到 1 张')

    const r3 = await mw(makeSession(`<img src="${IMG_2}"/>`), next)
    expect(r3).toBe('请输入合成描述')

    const r4 = await mw(makeSession('把两张图合成一张海报'), next)
    expect(String(r4)).toContain('1 ·') // 模型列表

    const r5 = await mw(makeSession('1'), next)
    expect(String(r5)).toContain('参数设置')

    const r6 = await mw(makeSession('跳过'), next)
    expect(String(r6)).toContain('确认生成')
    expect(String(r6)).toContain('模式 · 合成图')
    expect(String(r6)).toContain('图片 · 2 张')

    const r7 = await mw(makeSession('确认'), next)
    expect(r7).toBe('compose')
    expect(calls).toHaveLength(1)
    expect(calls[0].type).toBe('compose') // 关键：不再走 t2i
    const { args } = calls[0]
    expect(args[1]).toBe('把两张图合成一张海报')
    expect(args[6]).toEqual({ includeQuote: false, initialImages: [IMG_1, IMG_2] })
    expect(next).not.toHaveBeenCalled()
  })

  test('命令同条带 2 图 → 直接提示合成描述（Bug 4+6 衔接）', async () => {
    const { handler } = setup()
    const session = makeSession(`合成图 <img src="${IMG_1}"/><img src="${IMG_2}"/>`)
    const r = await handler.handleCommand(session, '合成图', makeArgv(session), undefined, undefined)
    expect(r).toBe('请输入合成描述')
  })

  test('confirm 步骤追加第 3 张图（合成图追加语义）', async () => {
    const { handler, calls } = setup()
    const next = vi.fn()
    const mw = handler.getMiddleware()

    const cmdSession = makeSession(`合成图 海报 <img src="${IMG_1}"/><img src="${IMG_2}"/>`)
    // 真实命令 action 会把解析出的行内描述作为 prompt 传入（见 commands/image.ts）
    const r1 = await handler.handleCommand(cmdSession, '合成图', makeArgv(cmdSession), undefined, '海报')
    expect(String(r1)).toContain('1 ·') // 有图有描述 → 直接模型列表

    await mw(makeSession('1'), next)
    await mw(makeSession('跳过'), next)

    const r = await mw(makeSession(`<img src="${IMG_3}"/>`), next)
    expect(String(r)).toContain('已更新图片（当前 3 张）')

    await mw(makeSession('确认'), next)
    expect(calls[0].args[6]).toEqual({ includeQuote: false, initialImages: [IMG_1, IMG_2, IMG_3] })
  })
})
