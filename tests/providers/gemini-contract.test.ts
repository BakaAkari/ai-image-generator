import { describe, expect, test, vi } from 'vitest'

import { GeminiProvider } from '../../src/providers/gemini.js'
import { getContractById } from '../../src/contracts/registry.js'

const NEWAPI_2_5 = getContractById('newapi.gemini.2-5.generate')!
const NEWAPI_3_PRO = getContractById('newapi.gemini.3-pro.generate')!
const NEWAPI_3_PRO_EDIT = getContractById('newapi.gemini.3-pro.edit')!
const OFFICIAL = getContractById('gemini.official.generate')!

function makeCtx(handler?: (url: string, body: unknown) => unknown) {
  const post = vi.fn(async (url: string, body: unknown) => {
    if (handler) return handler(url, body)
    return {
      candidates: [
        { content: { parts: [{ inline_data: { mime_type: 'image/png', data: 'AAAA' } }] } },
      ],
      usageMetadata: { totalTokenCount: 15 },
    }
  })
  const ctx = {
    http: { post, get: vi.fn() },
    logger: () => ({
      info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    }),
  } as any
  return { ctx, post }
}

function makeProvider(ctx: any, modelId = 'gemini-3-pro-image-preview', apiBase = 'https://yunwu.ai') {
  return new GeminiProvider({
    ctx,
    apiKey: 'k',
    modelId,
    apiBase,
    apiTimeout: 60,
    loggerName: 'test-gemini',
  })
}

describe('GeminiProvider yunwu 2.5 contract', () => {
  test('does NOT emit imageSize even if provided', async () => {
    let capturedBody: any
    const { ctx } = makeCtx((_, body) => { capturedBody = body; return { candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: 'AAAA' } }] } }] } })
    const provider = makeProvider(ctx, 'gemini-2.5-flash-image')
    await provider.generateImages('cat', '', 1, {
      contract: NEWAPI_2_5,
      operation: 'text-to-image',
      contractFields: { aspectRatio: '16:9' },
      numImages: 1,
    })
    expect(capturedBody.generationConfig.imageConfig).toEqual({ aspectRatio: '16:9' })
    expect(capturedBody.generationConfig.imageConfig.imageSize).toBeUndefined()
  })
})

describe('GeminiProvider yunwu 3 Pro contract', () => {
  test('emits uppercase imageSize + aspectRatio', async () => {
    let capturedBody: any
    const { ctx } = makeCtx((_, body) => { capturedBody = body; return { candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: 'AAAA' } }] } }] } })
    const provider = makeProvider(ctx)
    await provider.generateImages('cat', '', 1, {
      contract: NEWAPI_3_PRO,
      operation: 'text-to-image',
      contractFields: { imageSize: '2K', aspectRatio: '9:16' },
      numImages: 1,
    })
    expect(capturedBody.generationConfig.imageConfig).toEqual({ aspectRatio: '9:16', imageSize: '2K' })
  })
})

describe('GeminiProvider yunwu 3 Pro edit contract', () => {
  test('does NOT emit imageConfig; only responseModalities', async () => {
    let capturedBody: any
    const pngMagic = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    const { ctx } = makeCtx((_, body) => { capturedBody = body; return { candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: 'AAAA' } }] } }] } })
    ctx.http.get = vi.fn(async () => pngMagic.buffer)
    const provider = makeProvider(ctx)
    await provider.generateImages('edit', ['https://ref/1.png'], 1, {
      contract: NEWAPI_3_PRO_EDIT,
      operation: 'image-edit',
      contractFields: {},
      numImages: 1,
    })
    expect(capturedBody.generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'] })
  })

  test('all reference images fail → fail-closed, no fallback to text-to-image', async () => {
    const { ctx } = makeCtx()
    ctx.http.get = vi.fn(async () => { throw new Error('network') })
    const provider = makeProvider(ctx)
    await expect(
      provider.generateImages('edit', ['https://ref/bad.png'], 1, {
        contract: NEWAPI_3_PRO_EDIT,
        operation: 'image-edit',
        contractFields: {},
        numImages: 1,
      }),
    ).rejects.toThrow(/下载失败/)
  })
})

describe('GeminiProvider official contract', () => {
  test('official contract carries imageSize (uppercase) when provided', async () => {
    let capturedBody: any
    const { ctx } = makeCtx((_, body) => { capturedBody = body; return { candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: 'AAAA' } }] } }] } })
    const provider = makeProvider(ctx, 'gemini-3-pro', 'https://generativelanguage.googleapis.com')
    await provider.generateImages('cat', '', 1, {
      contract: OFFICIAL,
      operation: 'text-to-image',
      contractFields: { imageSize: '1K', aspectRatio: '1:1' },
      numImages: 1,
    })
    expect(capturedBody.generationConfig.imageConfig?.imageSize).toBe('1K')
  })

  test('official contract does NOT include response_format extension', async () => {
    let capturedBody: any
    const { ctx } = makeCtx((_, body) => { capturedBody = body; return { candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: 'AAAA' } }] } }] } })
    const provider = makeProvider(ctx, 'gemini-3-pro', 'https://generativelanguage.googleapis.com')
    await provider.generateImages('cat', '', 1, {
      contract: OFFICIAL,
      operation: 'text-to-image',
      contractFields: { imageSize: '1K', responseFormat: 'url' },
      numImages: 1,
    })
    expect(capturedBody).not.toHaveProperty('response_format')
  })
})

describe('GeminiProvider rejects rejectedParams', () => {
  test('non-empty rejectedParams → fail-closed before HTTP call', async () => {
    const { ctx, post } = makeCtx()
    const provider = makeProvider(ctx)
    await expect(
      provider.generateImages('cat', '', 1, {
        contract: NEWAPI_3_PRO,
        operation: 'text-to-image',
        contractFields: { imageSize: '1K' },
        rejectedParams: [{ key: 'imageSize', value: 'huge', reason: 'unsupported' }],
        numImages: 1,
      }),
    ).rejects.toThrow(/rejected|拒绝|不被/)
    expect(post).not.toHaveBeenCalled()
  })
})

describe('GeminiProvider response parsing', () => {
  test('inlineData (camelCase) parsed correctly', async () => {
    const { ctx } = makeCtx(() => ({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'BBBB' } }] } }],
    }))
    const provider = makeProvider(ctx)
    const result = await provider.generateImages('cat', '', 1, {
      contract: NEWAPI_3_PRO,
      operation: 'text-to-image',
      contractFields: { imageSize: '1K' },
      numImages: 1,
    })
    expect(result[0]).toMatch(/^data:image\/jpeg;base64,BBBB$/)
  })

  test('yunwu response_format=url at top-level data[]', async () => {
    const { ctx } = makeCtx(() => ({
      data: [{ url: 'https://cdn/x.png' }],
    }))
    const provider = makeProvider(ctx)
    const result = await provider.generateImages('cat', '', 1, {
      contract: NEWAPI_3_PRO,
      operation: 'text-to-image',
      contractFields: { imageSize: '1K', responseFormat: 'url' },
      numImages: 1,
    })
    expect(result).toEqual(['https://cdn/x.png'])
  })
})
