/**
 * 向导契约感知参数过滤 · 集成回归。
 *
 * 单等级契约(gpt-image-1)与无契约保守分支:参数页只展示契约可用选项。
 * 多等级 OpenAI 契约(gpt-image-2 系):走「先选分辨率 → 再收窄比例」依赖流,
 * 组合级约束在交互层消失;详细导航见 wizard-dependent-resolution.test.ts。
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

  test('gpt-image-2：依赖流——先选分辨率再收窄比例；4K 比例页仅 16:9/9:16', async () => {
    const { handler } = setup('yunwu.openai.gpt-image-2.generate')
    const next = vi.fn()
    const mw = handler.getMiddleware()

    // 选模型后进入分辨率页，而不是直接展示参数页
    const resPage = String(await reachParamSelect(handler))
    expect(resPage).toContain('选择分辨率')
    expect(resPage).toContain('标清 1K【默认】')
    expect(resPage).toContain('高清 2K')
    expect(resPage).toContain('超清 4K')
    expect(resPage).not.toContain('16:9') // 比例此时尚未展示

    // 非法编号 → 重提示
    const invalid = await mw(makeSession('9'), next)
    expect(String(invalid)).toContain('请输入 1-3 之间的编号')

    // 选 4K → 比例收窄为 16:9 / 9:16；1:1 / 3:2 不出现；分辨率参数已移除
    const paramPage = String(await mw(makeSession('3'), next))
    expect(paramPage).toContain('16:9')
    expect(paramPage).toContain('9:16')
    expect(paramPage).not.toContain('1:1')
    expect(paramPage).not.toContain('3:2')
    expect(paramPage).not.toContain('标清 1K')

    // 收窄后比例选项 [16:9, 9:16]：'2,1' = 9:16 + 张数 1 → 确认页含已选分辨率与比例
    const ok = await mw(makeSession('2,1'), next)
    expect(String(ok)).toContain('确认生成')
    expect(String(ok)).toContain('超清 4K')
    expect(String(ok)).toContain('9:16')
  })

  test('gpt-image-2-c：依赖流 + supportsN=false → 比例页无「生成张数」；连续「跳过」直达确认', async () => {
    const { handler } = setup('yunwu.openai.gpt-image-2-c.generate')
    const next = vi.fn()
    const mw = handler.getMiddleware()

    const resPage = String(await reachParamSelect(handler))
    expect(resPage).toContain('选择分辨率')

    const paramPage = String(await mw(makeSession('跳过'), next))
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
