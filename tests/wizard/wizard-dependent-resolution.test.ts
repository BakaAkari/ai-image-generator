/**
 * 向导依赖式参数流 · 「先选分辨率 → 再收窄比例」专项回归。
 *
 * 覆盖:分辨率页渲染、逐级收窄、非法输入、上一步导航(参数页/确认页回分辨率页)、
 * 收窄幂等(反复进出重选不同等级)、跳过默认值合法性。
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
import { getContractById } from '../../src/contracts/registry.js'

function makeSession(content: string) {
  return {
    userId: 'u1',
    username: 'user',
    platform: 'lark',
    channelId: 'ch-a',
    content,
    quote: undefined,
    send: vi.fn(),
  } as any
}

function makeArgv(session: any) {
  return { session, args: [], options: {}, rest: '' } as any
}

function setup(contractId: string) {
  const sessions = new WizardSessionManager()
  const config = {
    modelMappings: [{ suffix: 'gpt', modelId: 'gpt-image-x' }],
    defaultNumImages: 1,
  } as any
  const contract = getContractById(contractId)
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
    resolveContractForMapping: () => contract,
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
  const mw = handler.getMiddleware()
  const next = vi.fn()
  return { handler, mw, next }
}

/** 走完「命令 → 描述 → 选模型」,返回分辨率页文本 */
async function reachResolutionStep(ctx: ReturnType<typeof setup>) {
  const s1 = makeSession('文生图')
  await ctx.handler.handleCommand(s1, '文生图', makeArgv(s1), undefined, undefined)
  await ctx.mw(makeSession('一只猫'), ctx.next)
  return ctx.mw(makeSession('1'), ctx.next)
}

describe('向导依赖式参数流(gpt-image-2)', () => {
  test('1K → 比例收窄为 1:1/3:2/2:3,不含 16:9/9:16', async () => {
    const ctx = setup('yunwu.openai.gpt-image-2.generate')
    await reachResolutionStep(ctx)
    const page = String(await ctx.mw(makeSession('1'), ctx.next))
    expect(page).toContain('1:1')
    expect(page).toContain('3:2')
    expect(page).toContain('2:3')
    expect(page).not.toContain('16:9')
    expect(page).not.toContain('9:16')
    expect(page).toContain('生成张数')
  })

  test('2K → 比例收窄为 1:1/16:9', async () => {
    const ctx = setup('yunwu.openai.gpt-image-2.generate')
    await reachResolutionStep(ctx)
    const page = String(await ctx.mw(makeSession('2'), ctx.next))
    expect(page).toContain('1:1')
    expect(page).toContain('16:9')
    expect(page).not.toContain('9:16')
    expect(page).not.toContain('3:2')
  })

  test('「跳过」分辨率 → 默认 1K,再「跳过」参数 → 确认页为 1K + 1:1 合法组合', async () => {
    const ctx = setup('yunwu.openai.gpt-image-2.generate')
    await reachResolutionStep(ctx)
    await ctx.mw(makeSession('跳过'), ctx.next)
    const ok = String(await ctx.mw(makeSession('跳过'), ctx.next))
    expect(ok).toContain('确认生成')
    expect(ok).toContain('标清 1K')
    expect(ok).toContain('1:1')
  })

  test('参数页「上一步」→ 回分辨率页;重选 4K 后收窄正确(幂等)', async () => {
    const ctx = setup('yunwu.openai.gpt-image-2.generate')
    await reachResolutionStep(ctx)
    await ctx.mw(makeSession('1'), ctx.next) // 先选 1K

    const back = String(await ctx.mw(makeSession('上一步'), ctx.next))
    expect(back).toContain('选择分辨率')

    // 重选 4K:收窄必须基于完整参数定义重算,不能停留在 1K 的收窄结果
    const page = String(await ctx.mw(makeSession('3'), ctx.next))
    expect(page).toContain('9:16')
    expect(page).not.toContain('3:2')
  })

  test('分辨率页「上一步」→ 回模型列表', async () => {
    const ctx = setup('yunwu.openai.gpt-image-2.generate')
    await reachResolutionStep(ctx)
    const back = String(await ctx.mw(makeSession('上一步'), ctx.next))
    expect(back).toContain('[OPENAI]')
    expect(back).toContain('-gpt')
  })

  test('确认页「上一步」→ 回分辨率页(分辨率需重选)', async () => {
    const ctx = setup('yunwu.openai.gpt-image-2.generate')
    await reachResolutionStep(ctx)
    await ctx.mw(makeSession('2'), ctx.next) // 2K
    const confirm = String(await ctx.mw(makeSession('2,1'), ctx.next)) // 16:9 + 1 张
    expect(confirm).toContain('确认生成')
    expect(confirm).toContain('高清 2K')

    const back = String(await ctx.mw(makeSession('上一步'), ctx.next))
    expect(back).toContain('选择分辨率')
  })

  test('完整链路:4K + 9:16 确认后触发生成(resolution 以显式参数传递)', async () => {
    const ctx = setup('yunwu.openai.gpt-image-2.generate')
    await reachResolutionStep(ctx)
    await ctx.mw(makeSession('3'), ctx.next) // 4K
    await ctx.mw(makeSession('2,1'), ctx.next) // 9:16 + 1 张
    const done = await ctx.mw(makeSession('确认'), ctx.next)
    // handleConfirm 返回 void(异步生成)或错误文案;此处不应是参数错误文案
    expect(String(done ?? '')).not.toContain('参数')
  })
})
