/**
 * commands/image.ts 交互模式路由回归。
 *
 * 关注点：auto 模式下能否根据"用户指令全貌"（模型后缀 / 参数语法 / -n）决定
 * 走直接生成路径还是引导向导；guided / advanced 是否行为不变。
 *
 * 方式：构造最小 fake ctx，captureRegisteredCommands 记录每个命令的 action，
 * 然后直接调用 action，观察落到 wizardHandler.handleCommand 还是 handlers.executeXxx。
 */
import { describe, expect, test, vi } from 'vitest'

// stub koishi 以避免加载其 TS 源；仅提供 parser.ts / image.ts 需要的最小 h 语义
vi.mock('koishi', () => {
  const parseText = (raw: string) => {
    const s = typeof raw === 'string' ? raw : ''
    return s ? [{ type: 'text', attrs: { content: s }, children: [] }] : []
  }
  const select = (elements: any[], selector: string) => {
    if (!Array.isArray(elements)) return []
    return elements.filter((el) => el?.type === selector)
  }
  return { Argv: class {}, h: { parse: parseText, select }, Schema: class {} }
})

import { registerImageCommands } from '../../src/commands/image.js'
import { COMMANDS } from '../../src/shared/constants.js'
import type { Config } from '../../src/shared/config.js'
import type { ModelMappingConfig, ResolvedStyleConfig } from '../../src/shared/types.js'
type Argv = any

// ─── 最小 stub ──────────────────────────────────────────────────────────────

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as any

interface CommandRecord {
  name: string
  action?: (argv: Argv, ...rest: any[]) => any
}

function makeFakeCtx(): { ctx: any; commands: Map<string, CommandRecord> } {
  const commands = new Map<string, CommandRecord>()
  const command = (nameWithArgs: string) => {
    // 提取命令名（第一个空格前）
    const name = nameWithArgs.split(/\s+/)[0]
    const record: CommandRecord = { name }
    commands.set(name, record)
    const builder: any = {
      alias() { return builder },
      option() { return builder },
      action(fn: any) { record.action = fn; return builder },
      dispose() { commands.delete(name) },
    }
    return builder
  }
  const ctx = { command, logger: () => noopLogger }
  return { ctx, commands }
}

// ─── 记录性 handlers / service / wizardHandler ─────────────────────────────

interface CallTrace {
  wizardCalled: number
  wizardArgs: any[]
  directTextCalled: number
  directImageCalled: number
  directComposeCalled: number
  directArgs: any[]
}

function makeStubs(config: Config, opts: { freePlatform?: boolean; stylePresets?: ResolvedStyleConfig[] } = {}) {
  const trace: CallTrace = {
    wizardCalled: 0,
    wizardArgs: [],
    directTextCalled: 0,
    directImageCalled: 0,
    directComposeCalled: 0,
    directArgs: [],
  }

  const service = {
    checkModelAccess: () => ({ allowed: true }),
    checkFreeTrialForModel: () => ({ allowed: true }),
    isFreePlatform: () => !!opts.freePlatform,
    buildGenerationSetup: (num: number, modifiers: any) => ({
      requestContext: { numImages: num, modelId: modifiers?.modelMapping?.modelId },
      displayInfo: {},
    }),
    listStylePresets: () => opts.stylePresets ?? [],
    getStylePreset: (name: string) => (opts.stylePresets ?? []).find(s => s.commandName === name),
    // 下列方法在非账户命令路径中不会被触发；用 no-op 兜底避免 TypeError
    userManager: { isAdmin: () => false, buildCreditSummary: () => ({}) },
    getExistingUsageSummary: async () => null,
    getQuotaSummary: async () => null,
    getUsageRanking: async () => [],
    grantCredits: async () => ({}),
    adjustCredits: async () => ({}),
    listLedgerEvents: async () => [],
    formatCredits: (n: number) => `${n}`,
  } as any

  const handlers = {
    executeTextToImage: (session: any, prompt: any, ctx: any) => {
      trace.directTextCalled++
      trace.directArgs.push({ prompt, ctx })
      return Promise.resolve('direct-t2i')
    },
    executeImageToImage: (session: any, img: any, prompt: any, ctx: any) => {
      trace.directImageCalled++
      trace.directArgs.push({ img, prompt, ctx })
      return Promise.resolve('direct-i2i')
    },
    executeComposeImage: (session: any, prompt: any, ctx: any) => {
      trace.directComposeCalled++
      trace.directArgs.push({ prompt, ctx })
      return Promise.resolve('direct-compose')
    },
  }

  const wizardHandler = {
    handleCommand: (session: any, name: string, argv: any) => {
      trace.wizardCalled++
      trace.wizardArgs.push({ name, argv })
      return Promise.resolve('wizard-response')
    },
    getMiddleware: () => async () => undefined,
  }

  return { service, handlers, wizardHandler, trace }
}

// ─── config 构造 ─────────────────────────────────────────────────────────────

// 使用刻意"陌生"的映射证明配置驱动、无模型硬编码
const genericSuffixMapping: ModelMappingConfig = { suffix: 'wombat42', modelId: 'wombat-model-42' }
const secondMapping: ModelMappingConfig = { suffix: 'gpt', modelId: 'gpt-image-1' }

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    interactionMode: 'auto',
    interactionModeOverrides: undefined,
    modelMappings: [genericSuffixMapping, secondMapping],
    defaultNumImages: 1,
    ...overrides,
  } as unknown as Config
}

// ─── argv 构造 ───────────────────────────────────────────────────────────────

function makeArgv(session: any, content: string, options: Record<string, unknown> = {}): Argv {
  session.content = content
  return { session, args: [], options, rest: '' } as unknown as Argv
}

function makeSession(overrides: Record<string, any> = {}) {
  return {
    userId: 'u1',
    username: 'user',
    platform: 'lark',
    isDirect: true,
    content: '',
    ...overrides,
  } as any
}

// ─── 通用装配 ─────────────────────────────────────────────────────────────────

function setup(config: Config, opts: Parameters<typeof makeStubs>[1] = {}) {
  const { ctx, commands } = makeFakeCtx()
  const { service, handlers, wizardHandler, trace } = makeStubs(config, opts)
  registerImageCommands({
    ctx,
    service,
    handlers,
    getConfig: () => config,
    wizardHandler,
  })
  return { commands, service, handlers, wizardHandler, trace }
}

async function invoke(commands: Map<string, CommandRecord>, name: string, argv: Argv, ...rest: any[]) {
  const record = commands.get(name)
  if (!record?.action) throw new Error(`command not registered: ${name}`)
  return record.action(argv, ...rest)
}

// ─── 场景：auto + 直接语法 → direct ─────────────────────────────────────────

describe('auto 模式 · 私聊 · 识别到直接命令语法 → 直接生成', () => {
  test('任意已配置模型后缀 + 比例（`-wombat42 -16:9`）→ direct，跳过向导', async () => {
    const { commands, trace } = setup(baseConfig(), { freePlatform: true })
    const session = makeSession()
    await invoke(commands, COMMANDS.TXT_TO_IMG, makeArgv(session, '文生图 猫 -wombat42 -16:9'), '猫')
    expect(trace.wizardCalled).toBe(0)
    expect(trace.directTextCalled).toBe(1)
  })

  test('新增/陌生的 mapping 后缀（`-wombat42`）也能触发 direct — 非硬编码列表', async () => {
    const { commands, trace } = setup(baseConfig(), { freePlatform: true })
    const session = makeSession()
    await invoke(commands, COMMANDS.TXT_TO_IMG, makeArgv(session, '文生图 猫 -wombat42'), '猫')
    expect(trace.wizardCalled).toBe(0)
    expect(trace.directTextCalled).toBe(1)
  })

  test('Koishi prompt 残留模型/尺寸 flag 时，发送前剥离控制语法', async () => {
    const { commands, trace } = setup(baseConfig(), { freePlatform: true })
    const session = makeSession()
    await invoke(
      commands,
      COMMANDS.TXT_TO_IMG,
      makeArgv(session, '文生图 一只猫 -wombat42 -16:9'),
      '一只猫 -wombat42 -16:9',
    )
    expect(trace.directArgs[0].prompt).toBe('一只猫')
  })

  test('-add 内容只追加一次，控制词本身不进入 prompt', async () => {
    const { commands, trace } = setup(baseConfig(), { freePlatform: true })
    const session = makeSession()
    await invoke(
      commands,
      COMMANDS.TXT_TO_IMG,
      makeArgv(session, '文生图 一只猫 -add 强化细节 -wombat42'),
      '一只猫 -add 强化细节 -wombat42',
    )
    expect(trace.directArgs[0].prompt).toBe('一只猫 - 强化细节')
  })

  test('仅 -1k → direct（补默认模型/协议）', async () => {
    const { commands, trace } = setup(baseConfig(), { freePlatform: true })
    const session = makeSession()
    await invoke(commands, COMMANDS.TXT_TO_IMG, makeArgv(session, '文生图 猫 -1k'), '猫')
    expect(trace.wizardCalled).toBe(0)
    expect(trace.directTextCalled).toBe(1)
  })

  test('仅 -16:9 → direct', async () => {
    const { commands, trace } = setup(baseConfig(), { freePlatform: true })
    const session = makeSession()
    await invoke(commands, COMMANDS.TXT_TO_IMG, makeArgv(session, '文生图 猫 -16:9'), '猫')
    expect(trace.wizardCalled).toBe(0)
    expect(trace.directTextCalled).toBe(1)
  })

  test('自定义分辨率 -1024x2048 → direct', async () => {
    const { commands, trace } = setup(baseConfig(), { freePlatform: true })
    const session = makeSession()
    await invoke(commands, COMMANDS.TXT_TO_IMG, makeArgv(session, '文生图 猫 -1024x2048'), '猫')
    expect(trace.wizardCalled).toBe(0)
    expect(trace.directTextCalled).toBe(1)
  })

  test('-add 追加 → direct', async () => {
    const { commands, trace } = setup(baseConfig(), { freePlatform: true })
    const session = makeSession()
    await invoke(commands, COMMANDS.TXT_TO_IMG, makeArgv(session, '文生图 猫 -add 强化细节'), '猫')
    expect(trace.wizardCalled).toBe(0)
    expect(trace.directTextCalled).toBe(1)
  })

  test('有效 -n 4 → direct', async () => {
    const { commands, trace } = setup(baseConfig(), { freePlatform: true })
    const session = makeSession()
    await invoke(commands, COMMANDS.TXT_TO_IMG, makeArgv(session, '文生图 猫 -n 4', { num: 4 }), '猫')
    expect(trace.wizardCalled).toBe(0)
    expect(trace.directTextCalled).toBe(1)
  })
})

// ─── 场景：auto + 无直接语法 → 私聊仍走向导 ─────────────────────────────────

describe('auto 模式 · 私聊 · 无直接语法 → 保持向导', () => {
  test('单纯 prompt 无任何 flag → wizard', async () => {
    const { commands, trace } = setup(baseConfig())
    const session = makeSession()
    await invoke(commands, COMMANDS.TXT_TO_IMG, makeArgv(session, '文生图 一只猫'), '一只猫')
    expect(trace.wizardCalled).toBe(1)
    expect(trace.directTextCalled).toBe(0)
  })

  test('未识别的后缀不算直接语法 → wizard', async () => {
    const { commands, trace } = setup(baseConfig())
    const session = makeSession()
    await invoke(commands, COMMANDS.TXT_TO_IMG, makeArgv(session, '文生图 猫 -no-such-suffix'), '猫')
    expect(trace.wizardCalled).toBe(1)
    expect(trace.directTextCalled).toBe(0)
  })
})

// ─── 场景：guided → 始终 wizard；advanced → 始终 direct ─────────────────────

describe('guided 强制模式：任何输入都走向导', () => {
  test('即使带 mapping 后缀 + 比例，也保持 wizard（管理员强制向导）', async () => {
    const { commands, trace } = setup(baseConfig({ interactionMode: 'guided' as any }), { freePlatform: true })
    const session = makeSession()
    await invoke(commands, COMMANDS.TXT_TO_IMG, makeArgv(session, '文生图 猫 -wombat42 -16:9'), '猫')
    expect(trace.wizardCalled).toBe(1)
    expect(trace.directTextCalled).toBe(0)
  })
})

describe('advanced 强制模式：始终 direct', () => {
  test('普通 prompt 也直接生成', async () => {
    const { commands, trace } = setup(baseConfig({ interactionMode: 'advanced' as any }), { freePlatform: true })
    const session = makeSession()
    await invoke(commands, COMMANDS.TXT_TO_IMG, makeArgv(session, '文生图 一只猫'), '一只猫')
    expect(trace.wizardCalled).toBe(0)
    expect(trace.directTextCalled).toBe(1)
  })
})

// ─── 场景：style 命令 ─────────────────────────────────────────────────────

describe('style 快捷命令：显式后缀 / 参数触发 direct，显式后缀优先于 style 默认', () => {
  const stylePreset: ResolvedStyleConfig = {
    commandName: '酒神',
    prompt: 'Dionysus, mythology art',
    mode: 'text-to-image',
    modelSuffix: 'gpt',  // style 默认
  }

  test('style + 显式 mapping 后缀 → direct（不进向导）', async () => {
    const { commands, trace } = setup(baseConfig(), { freePlatform: true, stylePresets: [stylePreset] })
    const session = makeSession()
    await invoke(commands, '酒神', makeArgv(session, '酒神 -wombat42 -16:9'), undefined, undefined)
    expect(trace.wizardCalled).toBe(0)
    expect(trace.directTextCalled).toBe(1)
    // requestContext.modelId 应该来自显式 wombat42，不是 style 默认 gpt
    expect(trace.directArgs[0].ctx.modelId).toBe('wombat-model-42')
  })

  test('style 仅显式参数（无 mapping 后缀）→ direct，使用 style 默认模型', async () => {
    const { commands, trace } = setup(baseConfig(), { freePlatform: true, stylePresets: [stylePreset] })
    const session = makeSession()
    await invoke(commands, '酒神', makeArgv(session, '酒神 -16:9'), undefined, undefined)
    expect(trace.wizardCalled).toBe(0)
    expect(trace.directTextCalled).toBe(1)
    // style 默认 modelSuffix=gpt → gpt-image-1
    expect(trace.directArgs[0].ctx.modelId).toBe('gpt-image-1')
  })

  test('style 无任何用户语法 + 私聊 auto → 沿用旧默认（私聊 → wizard）', async () => {
    const { commands, trace } = setup(baseConfig(), { freePlatform: true, stylePresets: [stylePreset] })
    const session = makeSession()
    await invoke(commands, '酒神', makeArgv(session, '酒神'), undefined, undefined)
    expect(trace.wizardCalled).toBe(1)
    expect(trace.directTextCalled).toBe(0)
  })

  test('style 无任何用户语法 + 群聊 auto → 沿用旧默认（群聊 → direct）', async () => {
    const { commands, trace } = setup(baseConfig(), { freePlatform: true, stylePresets: [stylePreset] })
    const session = makeSession({ isDirect: false })
    await invoke(commands, '酒神', makeArgv(session, '酒神'), undefined, undefined)
    expect(trace.wizardCalled).toBe(0)
    expect(trace.directTextCalled).toBe(1)
  })

  test('guided 强制模式 · 即使 style 命令带显式后缀 → 仍进向导', async () => {
    const { commands, trace } = setup(
      baseConfig({ interactionMode: 'guided' as any }),
      { freePlatform: true, stylePresets: [stylePreset] },
    )
    const session = makeSession()
    await invoke(commands, '酒神', makeArgv(session, '酒神 -wombat42 -16:9'), undefined, undefined)
    expect(trace.wizardCalled).toBe(1)
    expect(trace.directTextCalled).toBe(0)
  })
})

// ─── 场景：图生图 & 合成图 都能识别直接意图 ──────────────────────────────────

describe('图生图 / 合成图 命令同样支持 direct 意图', () => {
  test('图生图 + `-wombat42 -3:2` → direct（不进向导）', async () => {
    const { commands, trace } = setup(baseConfig(), { freePlatform: true })
    const session = makeSession()
    await invoke(commands, COMMANDS.IMG_TO_IMG, makeArgv(session, '图生图 猫 -wombat42 -3:2'), undefined, '猫')
    expect(trace.wizardCalled).toBe(0)
    expect(trace.directImageCalled).toBe(1)
  })

  test('合成图 + `-1k` → direct', async () => {
    const { commands, trace } = setup(baseConfig(), { freePlatform: true })
    const session = makeSession()
    await invoke(commands, COMMANDS.COMPOSE_IMAGE, makeArgv(session, '合成图 -1k'), undefined)
    expect(trace.wizardCalled).toBe(0)
    expect(trace.directComposeCalled).toBe(1)
  })

  test('图生图 无直接语法 · 私聊 auto → wizard', async () => {
    const { commands, trace } = setup(baseConfig())
    const session = makeSession()
    await invoke(commands, COMMANDS.IMG_TO_IMG, makeArgv(session, '图生图 猫'), undefined, '猫')
    expect(trace.wizardCalled).toBe(1)
    expect(trace.directImageCalled).toBe(0)
  })
})

// ─── 场景：图生图无图 → 进入编排器等待补图（方案 A，2026-07-30） ──────────────

describe('图生图无图：直连路径不再提前拒绝，进入等待补图流程（Bug 2 方案 A）', () => {
  test('advanced 强制模式 · 无图 → 进入 executeImageToImage（等待补图）', async () => {
    const { commands, trace } = setup(baseConfig({ interactionMode: 'advanced' as any }), { freePlatform: true })
    const session = makeSession()
    const result = await invoke(commands, COMMANDS.IMG_TO_IMG, makeArgv(session, '图生图 猫'), undefined, '猫')
    expect(trace.wizardCalled).toBe(0)
    expect(trace.directImageCalled).toBe(1)
    expect(result).toBe('direct-i2i')
  })

  test('auto 群聊 · 无图 → 同样进入 executeImageToImage（等待补图）', async () => {
    const { commands, trace } = setup(baseConfig(), { freePlatform: true })
    const session = makeSession({ isDirect: false, guildId: 'g1' })
    const result = await invoke(commands, COMMANDS.IMG_TO_IMG, makeArgv(session, '图生图 猫'), undefined, '猫')
    expect(trace.wizardCalled).toBe(0)
    expect(trace.directImageCalled).toBe(1)
    expect(result).toBe('direct-i2i')
  })
})
