/**
 * utils/input.ts 单元测试。
 *
 * 回归重点：
 * - Bug 1：internal: / file: / base64:// 协议的图片 URL 字符串必须被接受
 *   （此前只接受 http/data:，导致 Lark 默认入站图在向导确认后被静默丢弃）。
 * - Bug 3.5：collectImagesFromParamAndQuote 支持 includeQuote=false，
 *   向导确认路径据此忽略「确认」消息引用的无关图片。
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
  return { h: { parse, select } }
})

import { collectImagesFromParamAndQuote, isSupportedImageUrl, parseMessageImagesAndText } from '../../src/utils/input.js'

function makeSession(overrides: Record<string, any> = {}) {
  return { content: '', quote: undefined, ...overrides } as any
}

describe('isSupportedImageUrl', () => {
  test.each([
    'http://example.com/a.png',
    'https://example.com/a.png',
    'data:image/png;base64,AAAA',
    'internal:lark/self123/im/v1/messages/m1/resources/k1?type=image',
    'internal:onebot/self456/xxx',
    'file:///tmp/a.png',
    'base64://iVBORw0KGgo=',
  ])('接受协议前缀：%s', (url) => {
    expect(isSupportedImageUrl(url)).toBe(true)
  })

  test.each([
    '一只猫',
    '图生图 描述文字',
    'ftp://example.com/a.png',
    '',
    '   ',
  ])('拒绝普通文本或未知协议：%s', (value) => {
    expect(isSupportedImageUrl(value)).toBe(false)
  })

  test('拒绝非字符串', () => {
    expect(isSupportedImageUrl(undefined)).toBe(false)
    expect(isSupportedImageUrl(null)).toBe(false)
    expect(isSupportedImageUrl(123)).toBe(false)
    expect(isSupportedImageUrl({ attrs: { src: 'http://x' } })).toBe(false)
  })
})

describe('collectImagesFromParamAndQuote', () => {
  test('字符串 imgParam：internal: URL 被接受（Bug 1 回归）', () => {
    const url = 'internal:lark/self123/im/v1/messages/m1/resources/k1?type=image'
    expect(collectImagesFromParamAndQuote(makeSession(), url)).toEqual([url])
  })

  test('字符串 imgParam：file: / base64:// 被接受', () => {
    expect(collectImagesFromParamAndQuote(makeSession(), 'file:///tmp/a.png')).toEqual(['file:///tmp/a.png'])
    expect(collectImagesFromParamAndQuote(makeSession(), 'base64://AAAA')).toEqual(['base64://AAAA'])
  })

  test('字符串 imgParam：普通文本不当作图片', () => {
    expect(collectImagesFromParamAndQuote(makeSession(), '一只猫')).toEqual([])
  })

  test('h 元素 imgParam：任意 src 均接受（对象分支不过滤协议）', () => {
    const el = { type: 'img', attrs: { src: 'internal:lark/x/y' } }
    expect(collectImagesFromParamAndQuote(makeSession(), el)).toEqual(['internal:lark/x/y'])
  })

  test('引用消息图片：默认收集；includeQuote=false 时忽略（Bug 3.5）', () => {
    const session = makeSession({
      quote: { elements: [{ type: 'img', attrs: { src: 'internal:lark/q/1' } }] },
    })
    expect(collectImagesFromParamAndQuote(session, undefined)).toEqual(['internal:lark/q/1'])
    expect(collectImagesFromParamAndQuote(session, undefined, true)).toEqual(['internal:lark/q/1'])
    expect(collectImagesFromParamAndQuote(session, undefined, false)).toEqual([])
  })

  test('显式图片 + 引用图片并存：includeQuote=false 只保留显式图片', () => {
    const session = makeSession({
      quote: { elements: [{ type: 'img', attrs: { src: 'internal:lark/q/1' } }] },
    })
    expect(collectImagesFromParamAndQuote(session, 'internal:lark/main/1', false)).toEqual(['internal:lark/main/1'])
  })

  test('无参数无引用 → 空数组', () => {
    expect(collectImagesFromParamAndQuote(makeSession(), undefined)).toEqual([])
  })
})

describe('parseMessageImagesAndText', () => {
  test('同时提取图片与文字（不过滤协议，供等待收集路径使用）', () => {
    const { images, text } = parseMessageImagesAndText('<img src="internal:lark/a/b"/>把背景换成蓝色')
    expect(images.map(i => i.attrs.src)).toEqual(['internal:lark/a/b'])
    expect(text).toBe('把背景换成蓝色')
  })

  test('纯文本', () => {
    const { images, text } = parseMessageImagesAndText('确认')
    expect(images).toEqual([])
    expect(text).toBe('确认')
  })
})
