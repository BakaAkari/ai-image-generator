import { describe, expect, test, vi } from 'vitest'

import { MjProvider } from '../../src/providers/midjourney.js'
import { getContractById } from '../../src/contracts/registry.js'

const MJ_IMAGINE = getContractById('newapi.mj.imagine')!
const MJ_REFERENCE = getContractById('newapi.mj.imagine.reference')!

function makeCtx(opts: {
  submitResponse?: unknown
  fetchResponses?: unknown[]
  onSubmit?: (body: unknown) => void
} = {}) {
  const fetchResponses = opts.fetchResponses ?? [{ status: 'SUCCESS', imageUrl: 'https://cdn/x.png' }]
  let fetchIndex = 0
  const post = vi.fn(async (_url: string, body: unknown) => {
    if (opts.onSubmit) opts.onSubmit(body)
    return opts.submitResponse ?? { code: 1, result: 'task-1', description: 'submit success' }
  })
  const get = vi.fn(async () => {
    const response = fetchResponses[Math.min(fetchIndex, fetchResponses.length - 1)]
    fetchIndex++
    return response
  })
  const ctx = {
    http: { post, get },
    logger: () => ({
      info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    }),
  } as any
  return { ctx, post, get }
}

function makeProvider(ctx: any, opts: { pollIntervalMs?: number; taskTimeoutMs?: number } = {}) {
  return new MjProvider({
    ctx,
    apiKey: 'k',
    modelId: 'mj_imagine',
    apiBase: '',
    apiTimeout: 60,
    loggerName: 'test',
    pollIntervalMs: opts.pollIntervalMs ?? 1,
    taskTimeoutMs: opts.taskTimeoutMs ?? 5000,
  })
}

describe('MjProvider Imagine body', () => {
  test('minimal body: botType + prompt, no model / imageUrl', async () => {
    let captured: any
    const { ctx } = makeCtx({ onSubmit: (body) => { captured = body } })
    const provider = makeProvider(ctx)
    await provider.generateImages('cat', '', 1, {
      contract: MJ_IMAGINE,
      operation: 'text-to-image',
      contractFields: { botType: 'MID_JOURNEY' },
      numImages: 1,
    })
    expect(captured).toMatchObject({ botType: 'MID_JOURNEY', prompt: 'cat' })
    expect(captured).not.toHaveProperty('model')
    expect(captured).not.toHaveProperty('imageUrl')
  })
})

describe('MjProvider polling timeout / unrecognized status', () => {
  test('IN_PROGRESS forever → task times out (short taskTimeoutMs, no real 300s wait)', async () => {
    const inProgressForever = Array(200).fill({ status: 'IN_PROGRESS', progress: '5%' })
    const { ctx } = makeCtx({ fetchResponses: inProgressForever })
    const provider = makeProvider(ctx, { pollIntervalMs: 1, taskTimeoutMs: 50 })
    await expect(
      provider.generateImages('cat', '', 1, {
        contract: MJ_IMAGINE,
        operation: 'text-to-image',
        contractFields: { botType: 'MID_JOURNEY' },
        numImages: 1,
      }),
    ).rejects.toThrow(/任务超时/)
  }, 5000)

  test('unrecognized status without imageUrl polled until timeout', async () => {
    const junkResponses = Array(200).fill({ status: 'WEIRD_STATUS' })
    const { ctx } = makeCtx({ fetchResponses: junkResponses })
    const provider = makeProvider(ctx, { pollIntervalMs: 1, taskTimeoutMs: 50 })
    await expect(
      provider.generateImages('cat', '', 1, {
        contract: MJ_IMAGINE,
        operation: 'text-to-image',
        contractFields: { botType: 'MID_JOURNEY' },
        numImages: 1,
      }),
    ).rejects.toThrow(/任务超时/)
  }, 5000)

  test('SUCCESS after some IN_PROGRESS polls resolves (uses short pollIntervalMs)', async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        { status: 'IN_PROGRESS' },
        { status: 'IN_PROGRESS' },
        { status: 'SUCCESS', imageUrl: 'https://cdn/finally.png' },
      ],
    })
    const provider = makeProvider(ctx, { pollIntervalMs: 1, taskTimeoutMs: 5000 })
    const result = await provider.generateImages('cat', '', 1, {
      contract: MJ_IMAGINE,
      operation: 'text-to-image',
      contractFields: { botType: 'MID_JOURNEY' },
      numImages: 1,
    })
    expect(result).toEqual(['https://cdn/finally.png'])
  })
})

describe('MjProvider Imagine polling', () => {
  test('SUCCESS with imageUrl returns url', async () => {
    const { ctx } = makeCtx({
      fetchResponses: [{ status: 'IN_PROGRESS' }, { status: 'SUCCESS', imageUrl: 'https://cdn/y.png' }],
    })
    const provider = makeProvider(ctx)
    // NOTE: This test would take ~3s due to polling interval; skip actual polling by making
    // POLL_INTERVAL_MS effectively zero via jest fake timers? Simpler: use direct SUCCESS.
    const { ctx: ctxImmediate } = makeCtx()
    const providerImmediate = makeProvider(ctxImmediate)
    const result = await providerImmediate.generateImages('cat', '', 1, {
      contract: MJ_IMAGINE,
      operation: 'text-to-image',
      contractFields: { botType: 'MID_JOURNEY' },
      numImages: 1,
    })
    expect(result).toEqual(['https://cdn/x.png'])
  })

  test('FAILURE throws with failReason', async () => {
    const { ctx } = makeCtx({
      fetchResponses: [{ status: 'FAILURE', failReason: 'parameter error' }],
    })
    const provider = makeProvider(ctx)
    await expect(
      provider.generateImages('cat', '', 1, {
        contract: MJ_IMAGINE,
        operation: 'text-to-image',
        contractFields: { botType: 'MID_JOURNEY' },
        numImages: 1,
      }),
    ).rejects.toThrow(/parameter error/)
  })

  test('reference images become base64Array (data URL)', async () => {
    let captured: any
    // Provide a minimal valid PNG (8-byte magic + IHDR)
    const pngMagic = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    const { ctx } = makeCtx({ onSubmit: (body) => { captured = body } })
    // downloadImageAsBase64 hits ctx.http.get with an image URL (arraybuffer);
    // task polling hits ctx.http.get on /mj/task/*/fetch (JSON). Disambiguate by URL.
    ctx.http.get = vi.fn(async (url: string) => {
      if (url.includes('/mj/task/')) return { status: 'SUCCESS', imageUrl: 'https://cdn/y.png' }
      return pngMagic.buffer
    })
    const provider = makeProvider(ctx)
    const result = await provider.generateImages('cat', ['https://ref/1.png'], 1, {
      contract: MJ_REFERENCE,
      operation: 'image-to-image',
      contractFields: { botType: 'MID_JOURNEY' },
      numImages: 1,
    })
    expect(result).toEqual(['https://cdn/y.png'])
    expect(Array.isArray(captured.base64Array)).toBe(true)
    expect(captured.base64Array[0]).toMatch(/^data:image\/png;base64,/)
  })

  test('all reference images fail to download → fail-closed, no fallback', async () => {
    const { ctx } = makeCtx()
    ctx.http.get = vi.fn(async () => { throw new Error('network') })
    const provider = makeProvider(ctx)
    await expect(
      provider.generateImages('cat', ['https://ref/bad.png'], 1, {
        contract: MJ_REFERENCE,
        operation: 'image-to-image',
        contractFields: { botType: 'MID_JOURNEY' },
        numImages: 1,
      }),
    ).rejects.toThrow(/下载失败/)
  })
})

describe('MjProvider rejects rejectedParams before submit', () => {
  test('non-empty rejectedParams → fail-closed', async () => {
    const { ctx, post } = makeCtx()
    const provider = makeProvider(ctx)
    await expect(
      provider.generateImages('cat', '', 1, {
        contract: MJ_IMAGINE,
        operation: 'text-to-image',
        contractFields: { botType: 'MID_JOURNEY' },
        rejectedParams: [{ key: 'stylize', value: 5000, reason: 'out of range' }],
        numImages: 1,
      }),
    ).rejects.toThrow(/rejected|拒绝|不被/)
    expect(post).not.toHaveBeenCalled()
  })
})

describe('MjProvider fail-closed for unknown contracts', () => {
  test('missing contract → throws', async () => {
    const { ctx } = makeCtx()
    const provider = makeProvider(ctx)
    await expect(
      provider.generateImages('cat', '', 1, { operation: 'text-to-image', numImages: 1 }),
    ).rejects.toThrow(/契约|contract/)
  })

  test('unknown contract id → throws', async () => {
    const { ctx } = makeCtx()
    const provider = makeProvider(ctx)
    const fakeContract: any = { ...MJ_IMAGINE, id: 'newapi.mj.action' }
    await expect(
      provider.generateImages('cat', '', 1, {
        contract: fakeContract,
        operation: 'image-edit',
        contractFields: { botType: 'MID_JOURNEY' },
        numImages: 1,
      }),
    ).rejects.toThrow(/未接入契约|contract/)
  })
})
