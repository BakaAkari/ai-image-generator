/**
 * ImageGenerationOrchestrator 输入收集回归。
 *
 * 覆盖：
 * - Bug 2（方案 A）：直连路径无图时进入「等待补发图片」流程，补发后正常生成。
 * - Bug 5：等待期间收到新指令 → 静默结束并放行（不吞指令、不回复多余错误）；
 *   收到「取消」→ 明确返回已取消。
 * - Bug 1：internal: 协议的图片 URL 字符串作为 imgParam 或补发图片时被正确收集。
 */
import { describe, expect, test, vi } from 'vitest'

vi.mock('koishi', () => {
  const parse = (raw: string) => {
    // 模拟 Koishi h.parse：任意 <tag .../> 解析为对应类型的元素，其余为 text
    const s = typeof raw === 'string' ? raw : ''
    const elements: any[] = []
    const tagRe = /<(\w+)\b[^>]*?\/?>/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = tagRe.exec(s))) {
      const before = s.slice(last, m.index)
      if (before) elements.push({ type: 'text', attrs: { content: before }, children: [] })
      const src = /src="([^"]*)"/.exec(m[0])?.[1]
      elements.push({ type: m[1], attrs: src ? { src } : {}, children: [] })
      last = m.index + m[0].length
    }
    const rest = s.slice(last)
    if (rest) elements.push({ type: 'text', attrs: { content: rest }, children: [] })
    return elements
  }
  const select = (elements: any[], selector: string) =>
    Array.isArray(elements) ? elements.filter((el) => el?.type === selector) : []
  const image = (url: string) => ({ type: 'img', attrs: { src: url }, children: [] })
  return { Argv: class {}, h: { parse, select, image }, Schema: class {} }
})

import { createImageGenerationHandlers } from '../../src/orchestrators/ImageGenerationOrchestrator.js'

const INTERNAL_IMG = 'internal:lark/self123/im/v1/messages/m1/resources/k1?type=image'
const INTERNAL_IMG_2 = 'internal:lark/self123/im/v1/messages/m2/resources/k2?type=image'

const fakeApp = {
  $commander: {
    get: (name: string) => (['文生图', '图生图', '图像查询'].includes(name) ? { name } : undefined),
  },
}

/** 模拟一条后续消息会话（waitUserInput callback 的入参） */
function incoming(content: string, strippedContent?: string) {
  return {
    content,
    stripped: { content: strippedContent ?? parseTextOnly(content) },
    app: fakeApp,
  } as any
}

function parseTextOnly(content: string) {
  return content.replace(/<img\b[^>]*\/?>/g, '').trim()
}

function setup(inbox: any[] = []) {
  const sent: string[] = []
  const providerCalls: { prompt: string; imageUrls: string[] }[] = []

  const session = {
    userId: 'u1',
    username: 'user',
    platform: 'lark',
    isDirect: true,
    guildId: undefined,
    content: '',
    quote: undefined,
    app: fakeApp,
    stripped: { content: '' },
    send: async (msg: any) => { sent.push(typeof msg === 'string' ? msg : JSON.stringify(msg)); return [] },
    // 模拟 Koishi session.prompt(callback)：取下一条消息喂给 callback；
    // 无消息视为超时返回 undefined；callback 返回 null 表示放行指令。
    prompt: async (callback: (s: any) => any, _options?: any) => {
      const next = inbox.shift()
      if (!next) return undefined
      return callback(next)
    },
  } as any

  const service = {
    isFreePlatform: () => true,
    requestProviderImages: async (prompt: string, imageUrls: string[], _n: number, _ctx: any, onImage: any) => {
      providerCalls.push({ prompt, imageUrls })
      await onImage('http://gen/1.png', 0, 1)
      return ['http://gen/1.png']
    },
    recordUsageOnly: async () => {},
    rememberGeneratedImages: () => {},
    calculateGenerationCost: () => ({}),
    lastProviderUsage: 0,
  } as any

  const userManager = {
    checkRateLimit: () => ({ allowed: true }),
    startTask: () => 'req-1',
    endTask: () => {},
  } as any

  const config = {
    apiTimeout: 60,
    defaultNumImages: 1,
    showCreditCostInResult: false,
    modelMappings: [],
  } as any

  const catalog = {
    current: { models: [{ id: 'gpt-image-1', pricing: { type: 'per-call', pricePerCall: 1 } }] },
    billingInfo: { supplierCredits: null },
  }

  const handlers = createImageGenerationHandlers({
    ctx: {} as any,
    service,
    userManager,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
    getConfig: () => config,
    catalog,
  })

  return { session, sent, providerCalls, handlers }
}

describe('图生图输入收集（编排器级）', () => {
  test('无图 → 等待补发 → 收到 internal: 图片后正常生成并透传 URL（Bug 1 + 2）', async () => {
    const { session, handlers, providerCalls, sent } = setup([incoming(`<img src="${INTERNAL_IMG}"/>`)])
    const result = await handlers.executeImageToImage(session, undefined, '把背景换成蓝色')

    expect(sent.some(m => m.includes('请在 60 秒内发送 1 张图片'))).toBe(true)
    expect(providerCalls).toHaveLength(1)
    expect(providerCalls[0].imageUrls).toEqual([INTERNAL_IMG])
    expect(providerCalls[0].prompt).toBe('把背景换成蓝色')
    expect(result).toContain('生成完成')
  })

  test('等待期间收到新指令 → 静默结束、放行指令、不触发生成（Bug 5）', async () => {
    const { session, handlers, providerCalls } = setup([incoming('文生图 一只猫')])
    const result = await handlers.executeImageToImage(session, undefined, '把背景换成蓝色')

    expect(result).toBe('')
    expect(providerCalls).toHaveLength(0)
  })

  test('等待期间收到「取消」→ 明确返回已取消（Bug 5）', async () => {
    const { session, handlers, providerCalls } = setup([incoming('取消')])
    const result = await handlers.executeImageToImage(session, undefined, '把背景换成蓝色')

    expect(result).toBe('已取消')
    expect(providerCalls).toHaveLength(0)
  })

  test('等待超时 → 返回超时错误', async () => {
    const { session, handlers, providerCalls } = setup([])
    const result = await handlers.executeImageToImage(session, undefined, '把背景换成蓝色')

    expect(result).toContain('等待超时')
    expect(providerCalls).toHaveLength(0)
  })

  test('imgParam 为 internal: 字符串 → 直接收集，不进入等待（Bug 1）', async () => {
    const { session, handlers, providerCalls, sent } = setup()
    const result = await handlers.executeImageToImage(session, INTERNAL_IMG, '把背景换成蓝色')

    expect(sent.some(m => m.includes('请在'))).toBe(false)
    expect(providerCalls).toHaveLength(1)
    expect(providerCalls[0].imageUrls).toEqual([INTERNAL_IMG])
    expect(result).toContain('生成完成')
  })

  test('imgParam 为 internal: 字符串 → includeQuote=false 忽略引用图（Bug 3.5）', async () => {
    const { session, handlers, providerCalls } = setup()
    session.quote = { elements: [{ type: 'img', attrs: { src: 'internal:lark/unrelated/9' } }] }
    const result = await handlers.executeImageToImage(
      session, INTERNAL_IMG, '把背景换成蓝色',
      undefined, undefined, '图生图', undefined, { includeQuote: false },
    )

    expect(providerCalls).toHaveLength(1)
    expect(providerCalls[0].imageUrls).toEqual([INTERNAL_IMG]) // 仅显式图，无引用图
    expect(result).toContain('生成完成')
  })

  test('补图等待中收到非图非文消息 → 反馈提示后继续等待（Bug 7）', async () => {
    const { session, handlers, providerCalls, sent } = setup([
      incoming('<face id="339"/>', ''),       // 贴纸：无图无文字
      incoming(`<img src="${INTERNAL_IMG}"/>`), // 随后补发图片
    ])
    const result = await handlers.executeImageToImage(session, undefined, '把背景换成蓝色')

    expect(sent.some(m => m.includes('未检测到图片，还需 1 张图片'))).toBe(true)
    expect(providerCalls).toHaveLength(1)
    expect(providerCalls[0].imageUrls).toEqual([INTERNAL_IMG])
    expect(result).toContain('生成完成')
  })
})

describe('合成图输入收集（编排器级，Bug 6）', () => {
  test('命令同条消息带 2 图 + 描述 → 直接生成，不再要求重发', async () => {
    const { session, handlers, providerCalls, sent } = setup()
    session.content = `合成图 海报 <img src="${INTERNAL_IMG}"/><img src="${INTERNAL_IMG_2}"/>`
    const result = await handlers.executeComposeImage(session, '海报')

    expect(sent.some(m => m.includes('请在'))).toBe(false) // 没有进入等待提示
    expect(providerCalls).toHaveLength(1)
    expect(providerCalls[0].imageUrls).toEqual([INTERNAL_IMG, INTERNAL_IMG_2])
    expect(result).toContain('生成完成')
  })

  test('命令同条消息带 2 图但无描述 → 带进度提示等待描述', async () => {
    const { session, handlers, providerCalls, sent } = setup([incoming('合成一张海报')])
    session.content = `合成图 <img src="${INTERNAL_IMG}"/><img src="${INTERNAL_IMG_2}"/>`
    const result = await handlers.executeComposeImage(session, undefined)

    expect(sent.some(m => m.includes('已收到 2 张'))).toBe(true)
    expect(providerCalls).toHaveLength(1)
    expect(providerCalls[0].prompt).toBe('合成一张海报')
    expect(result).toContain('生成完成')
  })

  test('引用消息图片也被收集（默认 includeQuote=true）', async () => {
    const { session, handlers, providerCalls } = setup()
    session.quote = {
      elements: [
        { type: 'img', attrs: { src: INTERNAL_IMG } },
        { type: 'img', attrs: { src: INTERNAL_IMG_2 } },
      ],
    }
    const result = await handlers.executeComposeImage(session, '海报')

    expect(providerCalls[0].imageUrls).toEqual([INTERNAL_IMG, INTERNAL_IMG_2])
    expect(result).toContain('生成完成')
  })

  test('向导预收集图片 + includeQuote=false（Bug 4 衔接）', async () => {
    const { session, handlers, providerCalls } = setup()
    session.quote = { elements: [{ type: 'img', attrs: { src: 'internal:lark/unrelated/9' } }] }
    const result = await handlers.executeComposeImage(
      session, '海报', undefined, undefined, '合成图', undefined,
      { includeQuote: false, initialImages: [INTERNAL_IMG, INTERNAL_IMG_2] },
    )

    expect(providerCalls[0].imageUrls).toEqual([INTERNAL_IMG, INTERNAL_IMG_2])
    expect(result).toContain('生成完成')
  })

  test('无图无描述 → 等待；等待期间收到新指令 → 放行（Bug 5 覆盖合成图）', async () => {
    const { session, handlers, providerCalls } = setup([incoming('图像查询')])
    const result = await handlers.executeComposeImage(session, undefined)

    expect(result).toBe('')
    expect(providerCalls).toHaveLength(0)
  })
})
