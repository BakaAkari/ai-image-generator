/**
 * 向导契约感知参数过滤 · 集成回归。
 *
 * 选定模型后参数页只展示契约可用选项；OpenAI「分辨率 × 比例」非法组合
 * 在参数输入时即时报错重选，不再等确认后失败。
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
  return { handler }
}

/** 走完「命令 → 描述 → 选模型」，返回参数页文本 */
async function reachParamSelect(handler: ReturnType<typeof setup>['handler']) {
  const next = vi.fn()
  const mw = handler.getMiddleware()
  const s1 = makeSession('文生图')
  await handler.handleCommand(s1, '文生图', makeArgv(s1), undefined, undefined)
  await mw(makeSession('一只猫'), next)
  return mw(makeSession('1'), next)
}

describe('向导契约感知参数过滤', () => {
  test('gpt-image-1：参数页只显示 1K 与 1:1（契约唯一合法组合）', async () => {
    const { handler } = setup('yunwu.openai.gpt-image-1.generate')
    const r = await reachParamSelect(handler)
    const text = String(r)
    expect(text).toContain('参数设置')
    expect(text).not.toContain('16:9')
    expect(text).not.toContain('4:3')
    expect(text).not.toContain('2K')
    expect(text).not.toContain('4K')
    expect(text).toContain('1 · 标清 1K【默认】')
    expect(text).toContain('1 · 1:1【默认】')
  })

  test('gpt-image-2：参数页不显示 4:3；非法组合 1K+16:9 即时报错重选，合法组合进入确认', async () => {
    const { handler } = setup('yunwu.openai.gpt-image-2.generate')
    const next = vi.fn()
    const mw = handler.getMiddleware()

    const paramPage = String(await reachParamSelect(handler))
    expect(paramPage).not.toContain('4:3')
    expect(paramPage).toContain('16:9') // 16:9 在 2K/4K 有映射，选项保留

    // 分辨率选项 [1k,2k,4k]，比例过滤后 [1:1,16:9,9:16,3:2,2:3]：1K+16:9 = '1,2,1'
    const bad = await mw(makeSession('1,2,1'), next)
    expect(String(bad)).toContain('参数组合不被当前模型接受')
    expect(String(bad)).toContain('1K + 16:9')

    // 2K+16:9 = '2,2,1' 合法 → 进入确认页
    const ok = await mw(makeSession('2,2,1'), next)
    expect(String(ok)).toContain('确认生成')
    expect(String(ok)).toContain('高清 2K')
    expect(String(ok)).toContain('16:9')
  })

  test('gpt-image-2-c：supportsN=false → 参数页不显示「生成张数」；「跳过」默认值合法直达确认', async () => {
    const { handler } = setup('yunwu.openai.gpt-image-2-c.generate')
    const next = vi.fn()
    const mw = handler.getMiddleware()

    const paramPage = String(await reachParamSelect(handler))
    expect(paramPage).not.toContain('生成张数')

    const ok = await mw(makeSession('跳过'), next)
    expect(String(ok)).toContain('确认生成')
    expect(String(ok)).not.toContain('生成张数')
  })

  test('无契约（未知模型）→ 保守展示协议全集，不阻断向导', async () => {
    const { handler } = setup('不存在的契约id')
    const paramPage = String(await reachParamSelect(handler))
    expect(paramPage).toContain('16:9')
    expect(paramPage).toContain('4:3')
    expect(paramPage).toContain('生成张数')
  })
})
