/**
 * V2 配置 Schema —— image-only，供应商语义 + 协议路由版本。
 *
 * 设计要点：
 * - 配置页顶层只暴露“OpenAI 兼容 / Gemini 官方 / GPT 官方”三类供应商入口。
 * - 每个供应商只负责凭证；模型统一在模型映射中配置。
 * - 模型映射显式配置 supplier（凭证入口）+ protocol（运行时协议通道）。
 * - 所有数值配置使用数字输入，不使用滑竿。
 */
import { Schema } from 'koishi'
import type {
  ImageProvider,
  ModelMappingConfig,
  StyleConfig,
  StyleGroupConfig,
} from './types.js'
import type { LogLevel } from './logging.js'

// ----------------------------------------------------------------------------
// 运行期 Config interface
// ----------------------------------------------------------------------------

export interface ProviderSettingsConfig {
  // OpenAI-compatible 第三方站点
  openaiCompatibleApiKey?: string
  openaiCompatibleApiBase?: string
  openaiCompatibleExtraHeaders?: Record<string, string>

  // OpenAI 官方 GPT
  gptOfficialApiKey?: string

  // Gemini 官方
  geminiOfficialApiKey?: string
}

const SETUP_GUIDE = [
  '首次配置：先填供应商凭证 → 前往左侧 aka-tools 面板管理模型目录、映射、预设与积分。',
  '模型规则：模型映射第一条是默认模型；聊天命令可用 -后缀 临时切换模型。',
  '计费规则：生成前按请求张数预检积分，生成后按成功发送图片数扣费。',
  '',
  '普通用户：',
  '文生图 <描述>                     文字生成图片，例如：文生图 一只猫 -16:9',
  '图生图 [图片] <描述>              单张参考图修改，例如：图生图 改成赛博朋克风格',
  '合成图 <描述>                     收集多张图片后合成，例如：合成图 把人物放到海报里',
  '图像查询                          查询自己的积分余额、已生成张数和历史消耗',
  '图像账单 [-n 数量]                查询自己的最近积分流水',
  '图像指令                          查看核心命令和快捷命令',
  '图像参数                          查看 -n、尺寸、比例、模型后缀等参数',
  '',
  '管理员：',
  '图像查询 @用户                    查询指定用户积分和统计',
  '图像账单 @用户 [-n 数量]          查询指定用户最近流水',
  '图像账单 --all [-n 数量]          查询全局最近流水',
  '图像充值 @用户 积分 [原因]        给用户充值；积分为负数时作为余额修正',
  '图像排行榜 [-n 数量]              查看用户生成和消耗排行',
  '',
  '常用参数：-n 1-4、-1k/-2k/-4k、-1:1/-4:3/-16:9/-9:16、-add 补充要求、-模型后缀。',
  '权限说明：受限模型需要管理员或模型白名单；白名单不代表免费。管理员、永久会员和豁免平台跳过扣费与限流，但仍记录统计。',
].join('\n')

export interface Config {
  // ── ⓪ 初始化说明 ──────────────────────────────────────────────────────────
  setupGuide?: string

  // ── ①b 激活供应商（互斥单选）与动态模型目录 ────────────────────────────────
  /** 互斥单选：模型目录与默认凭证来源 */
  activeSupplier?: 'yunwu' | 'gptgod' | 'openai-official' | 'gemini-official'
  /** 模型目录自动刷新间隔（小时） */
  catalogRefreshHours?: number
  /** 积分汇率：1 美元 = N 积分（目录计价自动换算用） */
  creditExchangeRate?: number
  /** 定价加成倍率（成本 × N = 用户积分价） */
  costMarkup?: number
  /** yunwu 积分→人民币换算（默认 0.5 = 100积分=¥50） */
  yunwuCreditToRmb?: number
  yunwuGroup?: string

  // ── ① 供应商凭证 ──────────────────────────────────────────────────────────
  /** @deprecated 0.5.9 起不再使用全局 provider 单选，保留字段避免 Koishi 反序列化报错 */
  provider?: ImageProvider
  providerSettings?: ProviderSettingsConfig

  // Legacy flat provider fields kept for runtime fallback when upgrading from <= 0.5.8.
  openaiCompatibleApiKey?: string
  openaiCompatibleApiBase?: string
  openaiCompatibleExtraHeaders?: Record<string, string>
  gptOfficialApiKey?: string
  geminiOfficialApiKey?: string

  // ── ② 图像生成 ────────────────────────────────────────────────────────────
  styles: StyleConfig[]
  styleGroups?: Record<string, StyleGroupConfig>
  showQuotaInImageCommands: boolean
  defaultNumImages: number

  // ── ③ 模型映射 ────────────────────────────────────────────────────────────
  modelMappings?: ModelMappingConfig[]

  // ── ④ 积分计费 ────────────────────────────────────────────────────────────
  creditUnitName: string
  /** @deprecated 0.9.0 仅用于旧配置读取，不参与运行时计费。 */
  defaultCreditCostPerImage?: number
  dailyFreeCredits: number
  showCreditCostInResult: boolean
  creditsPerCny?: number
  showEstimatedCny?: boolean
  minRechargeCredits?: number
  unlimitedPlatforms: string[]
  rateLimitWindow: number
  rateLimitMax: number

  // ── ⑤ 安全策略 ────────────────────────────────────────────────────────────
  securityBlockWindow: number
  securityBlockWarningThreshold: number

  // ── ⑥ 管理员设置 ──────────────────────────────────────────────────────────
  adminUsers: string[]
  permanentMembers: string[]
  modelWhitelistUsers: string[]
  logLevel: LogLevel

  // ── ⑦ ChatLuna 集成 ───────────────────────────────────────────────────────
  chatlunaEnabled: boolean
  chatlunaContextInjectionEnabled: boolean
  chatlunaExposeQuotaTool: boolean
  chatlunaExposeStyleListTool: boolean
  chatlunaContextHistorySize: number
  chatlunaContextTtlSeconds: number
  chatlunaPreferLastGeneratedInPrivateRoom: boolean

  // ── ⑧ YesImBot 集成 ──────────────────────────────────────────────────────
  yesimbotEnabled: boolean
  yesimbotExposeQuotaTool: boolean
  yesimbotExposeStyleListTool: boolean

  // ── 通用 ──────────────────────────────────────────────────────────────────
  apiTimeout: number
}

// ----------------------------------------------------------------------------
// 子 Schema
// ----------------------------------------------------------------------------

const StyleItemSchema = Schema.object({
  commandName: Schema.string()
    .required()
    .description('命令名')
    .role('table-cell', { width: 24 }),
  mode: Schema.union([
    Schema.const('text-to-image').description('文生图'),
    Schema.const('image-to-image').description('图生图'),
    Schema.const('compose-image').description('合成图'),
  ])
    .default('image-to-image')
    .description('生成模式')
    .role('table-cell', { width: 24 }),
  modelSuffix: Schema.string()
    .default('')
    .description('生成模型')
    .role('table-cell', { width: 24 }),
  description: Schema.string()
    .role('textarea', { rows: 2 })
    .description('帮助说明'),
  prompt: Schema.string()
    .role('textarea', { rows: 6 })
    .required()
    .description('提示词'),
})

const ProviderSettingsSchema = Schema.object({
  openaiCompatibleApiKey: Schema.string()
    .role('secret')
    .default('')
    .description('第三方 Key，用于云雾等兼容站点'),
  openaiCompatibleApiBase: Schema.string()
    .default('https://yunwu.ai/v1')
    .description('第三方 Base，通常以 /v1 结尾'),
  openaiCompatibleExtraHeaders: Schema.dict(Schema.string())
    .default({})
    .description('额外请求头；不需要时留空'),

  gptOfficialApiKey: Schema.string()
    .role('secret')
    .default('')
    .description('OpenAI Key，仅用于官方 OpenAI'),

  geminiOfficialApiKey: Schema.string()
    .role('secret')
    .default('')
    .description('Gemini Key，仅用于 Google 官方 Gemini'),
})

// 顶层供应商分组：不再使用单选 union，改为直接展示三个凭证区（默认收起）
const SupplierSchema = Schema.object({
  providerSettings: ProviderSettingsSchema
    .description('配置各供应商的 API Key 与接口地址')
    .collapse(),
}).description('🎨 供应商')

// ①b 激活供应商（互斥单选）+ 动态模型目录
const ActiveSupplierSchema = Schema.object({
  activeSupplier: Schema.union([
    Schema.const('yunwu').description('云雾 yunwu.ai（使用上方"第三方"凭证）'),
    Schema.const('gptgod').description('GPTGod（使用上方"第三方"凭证，改 Base 为 gptgod.cloud）'),
    Schema.const('openai-official').description('OpenAI 官方（使用上方 OpenAI 凭证）'),
    Schema.const('gemini-official').description('Gemini 官方（使用上方 Gemini 凭证）'),
  ])
    .default('yunwu')
    .description('激活供应商（互斥）：模型目录从该供应商动态获取'),
  catalogRefreshHours: Schema.number()
    .default(6)
    .min(1)
    .max(72)
    .step(1)
    .description('模型目录自动刷新间隔（小时）；聊天命令"图像模型"可手动刷新'),
  creditExchangeRate: Schema.number()
    .default(1000)
    .min(0)
    .step(1)
    .description('积分汇率：1 美元 = N 积分；模型映射积分价留空时按目录计价自动换算'),
    yunwuCreditToRmb: Schema.number()
      .default(0.5)
      .min(0.01)
      .max(100)
      .step(0.01)
      .description('yunwu 积分→人民币换算（默认 0.5 = 100积分=¥50）。仅影响 aka-tools 成本展示，不参与计费。'),
    yunwuGroup: Schema.string()
      .default('default')
      .description('yunwu API Key 所属分组，影响成本计算中的分组倍率。在 yunwu 后台 API 令牌页面查看。'),
  costMarkup: Schema.number()
    .default(1.3)
    .min(0.1)
    .step(0.05)
    .description('定价加成倍率：目录成本 × N = 向用户收取的积分价'),
}).description('🛰️ 激活供应商 / 动态模型目录')

// ----------------------------------------------------------------------------
// 顶层 Schema
// ----------------------------------------------------------------------------

export const Config = Schema.intersect([
  // ⓪ 初始化说明（只读引导）
  Schema.object({
    setupGuide: Schema.string()
      .role('textarea', { rows: 22 })
      .default(SETUP_GUIDE)
      .description('只读速查：首次配置顺序、聊天命令和管理员命令')
      .disabled(),
  }).description('📌 使用说明 / 命令速查'),

  // ① 供应商（直接展示凭证，无单选）
  SupplierSchema,

  // ①b 激活供应商 / 动态模型目录
  ActiveSupplierSchema,

  // ② 模型映射（先定义可用模型后缀，再供命令参数与 prompt 预设引用）
  Schema.object({
    modelMappings: Schema.array(
      Schema.object({
        suffix: Schema.string().required().description('命令名').role('table-cell', { width: 12 }),
        modelId: Schema.dynamic('image-generator.models')
          .required()
          .description('模型（来自动态目录）'),
        restricted: Schema.boolean()
          .default(false)
          .description('限制项')
          .role('table-cell', { width: 10 }),
        chargePolicy: Schema.union([
          Schema.object({
            type: Schema.const('fixed').required(),
            creditsPerImage: Schema.number().min(0).max(100000).step(0.01).required(),
          }).description('固定积分/张'),
          Schema.object({
            type: Schema.const('cost-plus').required(),
            acceptEstimated: Schema.boolean().default(false),
          }).description('目录成本 × 汇率 × 加成；拒绝无明确公式的估算'),
          Schema.object({
            type: Schema.const('disabled').required(),
            reason: Schema.string().default('pricing unavailable'),
          }).description('禁用'),
        ]).description('显式收费策略'),
        creditCostPerImage: Schema.number()
          .hidden()
          .description('旧字段，仅用于迁移'),
      }).collapse()
    )
      .role('table')
      .default([])
      .description('模型路由；第一条为默认模型。供应商与协议由激活供应商统一决定，不在此配置'),
  }).description('🔀 模型映射（请前往 aka-tools 面板管理）').collapse().hidden(),

  // ③ Prompt 预设 / 快捷命令
  Schema.object({
    styles: Schema.array(StyleItemSchema)
      .role('table')
      .default([
        {
          commandName: '变手办',
          mode: 'image-to-image',
          modelSuffix: '',
          description: '图像风格转换',
          prompt:
            '将这张照片变成手办模型。在它后面放置一个印有图像主体的盒子，桌子上有一台电脑显示Blender建模过程。在盒子前面添加一个圆形塑料底座，角色手办站在上面。如果可能的话，将场景设置在室内',
        },
        {
          commandName: '变写实',
          mode: 'image-to-image',
          modelSuffix: '',
          description: '图像风格转换',
          prompt:
            '请根据用户提供的图片，在严格保持主体身份、外观特征与姿态不变的前提下，生成一张照片级真实感的超写实摄影作品。要求：1. 采用专业相机拍摄（如佳能EOS R5），使用85mm f/1.4人像镜头；2. 画面应具有照片级真实感、超现实主义风格和高细节表现；3. 使用自然光影营造真实氛围；4. 整体效果需像专业摄影棚拍摄的真实照片。',
        },
      ])
      .description('直接注册为聊天命令的 Prompt 预设；重载配置后自动刷新'),
    styleGroups: Schema.dict(
      Schema.object({
        prompts: Schema.array(StyleItemSchema)
          .role('table')
          .default([])
          .description('本分组内的快捷命令预设'),
      })
    )
      .role('table')
      .default({})
      .description('按分组管理快捷命令；重载配置后自动刷新'),
  }).description('🧩 Prompt 预设（aka-tools 面板管理）').hidden(),

  // ④ 管理员与运营
  Schema.object({
    adminUsers: Schema.array(Schema.string())
      .default([])
      .description('管理员用户 ID；可查询他人、充值或余额修正、查账并使用受限模型'),
  }).description('👑 管理员与运营（aka-tools 面板管理）').hidden(),

  // ⑤ 用户豁免与白名单
  Schema.object({
    permanentMembers: Schema.array(Schema.string())
      .default([])
      .description('跳过积分扣费和限流，但不自动获得受限模型权限'),
    modelWhitelistUsers: Schema.array(Schema.string())
      .default([])
      .description('允许使用受限模型；不代表免费或管理员权限'),
  }).description('🪪 用户豁免与白名单（aka-tools 面板管理）').collapse().hidden(),

  // ⑥ 积分计费与限流
  Schema.object({
    creditUnitName: Schema.string()
      .default('积分')
      .description('聊天输出里的余额单位'),
    defaultCreditCostPerImage: Schema.number()
      .hidden()
      .description('旧字段，仅用于配置迁移；不参与运行时计费'),
    dailyFreeCredits: Schema.number()
      .default(5)
      .min(0)
      .max(100000)
      .step(0.01)
      .description('普通用户每天免费积分，支持小数'),
    showCreditCostInResult: Schema.boolean()
      .default(true)
      .description('生成完成后显示本次消耗和剩余积分'),
    creditsPerCny: Schema.number()
      .default(0)
      .min(0)
      .max(100000)
      .step(0.01)
      .description('经营参考：1 元对应多少积分；0 表示不估算，支持小数'),
    showEstimatedCny: Schema.boolean()
      .default(false)
      .description('管理员查询时显示余额估算金额'),
    minRechargeCredits: Schema.number()
      .default(0)
      .min(0)
      .max(1000000)
      .step(0.01)
      .description('充值提示用最低积分，支持小数；不限制管理员输入'),
    unlimitedPlatforms: Schema.array(Schema.string())
      .default(['lark'])
      .description('这些平台跳过积分扣费和限流'),
    rateLimitWindow: Schema.number()
      .default(300)
      .min(60)
      .max(3600)
      .step(30)
      .description('限流统计窗口，单位秒'),
    rateLimitMax: Schema.number()
      .default(3)
      .min(1)
      .max(20)
      .step(1)
      .description('每个窗口内允许的请求次数'),
  }).description('💳 积分计费与限流（aka-tools 面板管理）').collapse().hidden(),

  // ⑥ 安全策略
  Schema.object({
    securityBlockWindow: Schema.number()
      .default(600)
      .min(60)
      .max(3600)
      .step(60)
      .description('安全拦截统计窗口，单位秒'),
    securityBlockWarningThreshold: Schema.number()
      .default(3)
      .min(1)
      .max(10)
      .step(1)
      .description('窗口内触发多少次拦截后给出警示'),
  }).description('🛡️ 安全策略（aka-tools 面板管理）').collapse().hidden(),

  // ⑦ ChatLuna 集成（默认收起）
  Schema.object({
    chatlunaEnabled: Schema.boolean()
      .default(false)
      .description('启用后会在 ChatLuna 中注册图像生成工具，支持自然语言驱动生成'),
    chatlunaContextInjectionEnabled: Schema.boolean()
      .default(true)
      .description('在 ChatLuna 对话开始前注入最近图像上下文，支持“继续上一张”等自然语言跟进'),
    chatlunaExposeQuotaTool: Schema.boolean()
      .default(true)
      .description('是否暴露积分查询工具给 ChatLuna'),
    chatlunaExposeStyleListTool: Schema.boolean()
      .default(true)
      .description('是否暴露风格列表工具给 ChatLuna'),
    chatlunaContextHistorySize: Schema.number()
      .default(20)
      .min(1)
      .max(100)
      .step(1)
      .description('每个 ChatLuna 会话保留的图像上下文条数'),
    chatlunaContextTtlSeconds: Schema.number()
      .default(86400)
      .min(3600)
      .max(604800)
      .step(3600)
      .description('图像上下文过期时间，单位秒；默认 24 小时'),
    chatlunaPreferLastGeneratedInPrivateRoom: Schema.boolean()
      .default(true)
      .description('私有房间中自动将“上一张”等自然语言映射到最近生成的图像'),
  }).description('💬 ChatLuna 集成（aka-tools 面板管理）').collapse().hidden(),

  // ⑧ YesImBot 集成（默认收起）
  Schema.object({
    yesimbotEnabled: Schema.boolean()
      .default(false)
      .description('启用后会在 YesImBot 中注册 AI 图像生成工具，让 YesImBot 可以调用本插件的图像生成能力'),
    yesimbotExposeQuotaTool: Schema.boolean()
      .default(true)
      .description('是否向 YesImBot 暴露积分查询工具'),
    yesimbotExposeStyleListTool: Schema.boolean()
      .default(true)
      .description('是否向 YesImBot 暴露风格列表工具'),
  }).description('🤖 YesImBot 集成（aka-tools 面板管理）').collapse().hidden(),

  // ⚙️ 运行与诊断
  Schema.object({
    logLevel: Schema.union([
      Schema.const('simple').description('simple'),
      Schema.const('detail').description('detail'),
    ])
      .default('simple')
      .description('日志级别；simple 记录关键流程，detail 增加脱敏请求诊断'),
    showQuotaInImageCommands: Schema.boolean()
      .default(true)
      .description('生成完成后额外显示剩余积分明细（需先开启"显示本次消耗"）'),
    defaultNumImages: Schema.number()
      .default(1)
      .min(1)
      .max(4)
      .step(1)
      .description('未填写 -n 时默认生成的图片数量'),
    apiTimeout: Schema.number()
      .default(60)
      .min(10)
      .max(600)
      .step(10)
      .description('上游请求超时时间，单位秒'),
  }).description('🧰 运行与诊断').collapse(),
]) as unknown as Schema<Config>
