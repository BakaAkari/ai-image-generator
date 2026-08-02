import { describe, expect, test, vi } from 'vitest'

import { OpenAIProvider } from '../../src/providers/openai.js'
import { getContractById } from '../../src/contracts/registry.js'

const GEN = getContractById('newapi.openai.gpt-image-2.generate')!
const EDIT = getContractById('newapi.openai.gpt-image-2.edit')!
const GEN_C = getContractById('newapi.openai.gpt-image-2-c.generate')!

function makeCtx(handler?: (url: string, body: unknown) => unknown) {
  const post = vi.fn(async (url: string, body: unknown) => {
    if (handler) return handler(url, body)
    return { data: [{ b64_json: 'AAAA' }] }
  })
  const ctx = {
    http: { post, get: vi.fn() },
    logger: () => ({
      info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    }),
  } as any
  return { ctx, post }
}

function makeProvider(ctx: any, modelId = 'gpt-image-2') {
  return new OpenAIProvider({
    ctx,
    apiKey: 'k',
    modelId,
    apiBase: 'https://api.openai.com/v1',
    apiTimeout: 60,
    loggerName: 'test-openai',
  })
}

describe('OpenAIProvider create (contract-driven)', () => {
  test('body includes size from contractFields; JSON content-type; endpoint /v1/images/generations', async () => {
    let captured: any
    const { ctx, post } = makeCtx((_, body) => {
      captured = body
      return { data: [{ url: 'https://cdn/x.png' }], usage: { total_tokens: 12 } }
    })
    const provider = makeProvider(ctx)
    const result = await provider.generateImages('cat', '', 1, {
      contract: GEN,
      operation: 'text-to-image',
      contractFields: { size: '2048x1152' },
      aspectRatio: '16:9',
      resolution: '2k',
      numImages: 1,
    })
    expect(post.mock.calls[0][0]).toContain('/v1/images/generations')
    expect(captured).toMatchObject({ model: 'gpt-image-2', prompt: 'cat', n: 1, size: '2048x1152' })
    expect(result).toEqual(['https://cdn/x.png'])
  })

  test('response b64_json → data URL', async () => {
    const { ctx } = makeCtx(() => ({ data: [{ b64_json: 'AAAA' }] }))
    const provider = makeProvider(ctx)
    const result = await provider.generateImages('cat', '', 1, {
      contract: GEN,
      operation: 'text-to-image',
      contractFields: { size: '1024x1024' },
      numImages: 1,
    })
    expect(result[0]).toMatch(/^data:image\/png;base64,AAAA$/)
  })

  test('usage.total_tokens captured', async () => {
    const { ctx } = makeCtx(() => ({ data: [{ url: 'https://cdn/x.png' }], usage: { total_tokens: 42 } }))
    const provider = makeProvider(ctx)
    await provider.generateImages('cat', '', 1, {
      contract: GEN,
      operation: 'text-to-image',
      contractFields: { size: '1024x1024' },
      numImages: 1,
    })
    expect(provider.lastTotalTokens).toBe(42)
  })

  test('missing contract → fail-closed', async () => {
    const { ctx } = makeCtx()
    const provider = makeProvider(ctx)
    await expect(
      provider.generateImages('cat', '', 1, { operation: 'text-to-image', numImages: 1 }),
    ).rejects.toThrow(/契约|contract/)
  })

  test('gpt-image-2-c: numImages=2 → 2 calls each with n=1', async () => {
    let calls = 0
    const bodies: any[] = []
    const { ctx, post } = makeCtx((_, body) => {
      calls++
      bodies.push(body)
      return { data: [{ url: `https://cdn/${calls}.png` }] }
    })
    const provider = new OpenAIProvider({
      ctx,
      apiKey: 'k',
      modelId: 'gpt-image-2-c',
      apiBase: 'https://api.openai.com/v1',
      apiTimeout: 60,
      loggerName: 'test-openai-c',
    })
    const result = await provider.generateImages('cat', '', 2, {
      contract: GEN_C,
      operation: 'text-to-image',
      contractFields: { size: '1024x1024' },
      numImages: 2,
    })
    expect(post).toHaveBeenCalledTimes(2)
    expect(bodies.every(b => b.n === 1)).toBe(true)
    expect(result).toEqual(['https://cdn/1.png', 'https://cdn/2.png'])
  })

  test('provider refuses when imageOptions carries rejectedParams', async () => {
    const { ctx } = makeCtx()
    const provider = makeProvider(ctx)
    await expect(
      provider.generateImages('cat', '', 1, {
        contract: GEN,
        operation: 'text-to-image',
        contractFields: { size: '1024x1024' },
        rejectedParams: [{ key: 'quality', value: 'ultra', reason: 'not supported' }],
        numImages: 1,
      }),
    ).rejects.toThrow(/参数不被|rejected|拒绝/)
  })
})

describe('OpenAIProvider edit (multipart, no JSON-first fallback)', () => {
  test('edit hits /v1/images/edits with multipart body', async () => {
    const pngMagic = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    let capturedUrl = ''
    let capturedBody: any
    const { ctx } = makeCtx((url, body) => {
      capturedUrl = url
      capturedBody = body
      return { data: [{ url: 'https://cdn/e.png' }] }
    })
    ctx.http.get = vi.fn(async () => pngMagic.buffer)
    const provider = makeProvider(ctx)
    await provider.generateImages('draw', ['https://ref/1.png'], 1, {
      contract: EDIT,
      operation: 'image-edit',
      contractFields: { size: '1024x1024' },
      numImages: 1,
    })
    expect(capturedUrl).toContain('/v1/images/edits')
    // multipart body is a FormData (globalThis.FormData or koishi's)
    expect(capturedBody).toBeInstanceOf(FormData)
  })

  test('edit with no valid input images → fail-closed error before HTTP call', async () => {
    const { ctx } = makeCtx()
    ctx.http.get = vi.fn(async () => { throw new Error('network') })
    const provider = makeProvider(ctx)
    await expect(
      provider.generateImages('draw', ['https://ref/bad.png'], 1, {
        contract: EDIT,
        operation: 'image-edit',
        contractFields: { size: '1024x1024' },
        numImages: 1,
      }),
    ).rejects.toThrow(/下载失败/)
  })
})
