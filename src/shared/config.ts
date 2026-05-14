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
  '初始化顺序：先填供应商凭证，再检查模型映射，最后按需配置快捷命令。',
  '供应商只决定使用哪组 Key / Base；协议决定请求格式；模型 ID 是上游真实模型名。',
  '模型映射第一条是默认模型；命令中可用 -后缀 临时切换模型。',
  'styles / styleGroups 会注册为聊天快捷命令；重载配置后会自动刷新。',
  '受限模型仅管理员或模型白名单可用；永久会员只跳过额度和限流。',
].join('\n')

export interface Config {
  // ── ⓪ 初始化说明 ──────────────────────────────────────────────────────────
  setupGuide?: string

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

  // ── ④ 限流与配额 ──────────────────────────────────────────────────────────
  dailyFreeLimit: number
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

// ----------------------------------------------------------------------------
// 顶层 Schema
// ----------------------------------------------------------------------------

export const Config = Schema.intersect([
  // ⓪ 初始化说明（只读引导）
  Schema.object({
    setupGuide: Schema.string()
      .role('textarea', { rows: 5 })
      .default(SETUP_GUIDE)
      .description('只读引导：按这个顺序完成首次配置')
      .disabled(),
  }).description('📌 初始化说明'),

  // ① 供应商（直接展示凭证，无单选）
  SupplierSchema,

  // ② 模型映射（先定义可用模型后缀，再供命令参数与 prompt 预设引用）
  Schema.object({
    modelMappings: Schema.array(
      Schema.object({
        suffix: Schema.string().required().description('命令名'),
        modelId: Schema.string().required().description('模型 ID'),
        supplier: Schema.union([
          Schema.const('openai-compatible').description('第三方'),
          Schema.const('gpt-official').description('OpenAI'),
          Schema.const('gemini-official').description('Gemini'),
        ])
          .default('openai-compatible')
          .description('供应商'),
        protocol: Schema.union([
          Schema.const('openai').description('OpenAI'),
          Schema.const('gemini').description('Gemini'),
        ])
          .default('openai')
          .description('接口格式'),
        restricted: Schema.boolean()
          .default(false)
          .description('限制项'),
      }).collapse()
    )
      .role('table')
      .default([
        {
          suffix: 'gpt',
          modelId: 'gpt-image-2',
          supplier: 'gpt-official',
          protocol: 'openai',
          restricted: false,
        },
        {
          suffix: 'gemini',
          modelId: 'gemini-3-pro-image-preview',
          supplier: 'openai-compatible',
          protocol: 'gemini',
          restricted: false,
        },
      ])
      .description('模型路由；第一条为默认模型，快捷命令可通过模型后缀引用'),
  }).description('🔀 模型映射').collapse(),

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
  }).description('🧩 Prompt 预设 / 快捷命令'),

  // ④ 管理员与权限
  Schema.object({
    adminUsers: Schema.array(Schema.string())
      .default([])
      .description('管理员用户 ID，可查询用量并使用受限模型'),
    permanentMembers: Schema.array(Schema.string())
      .default([])
      .description('跳过额度和限流，但不自动获得受限模型权限'),
    modelWhitelistUsers: Schema.array(Schema.string())
      .default([])
      .description('允许使用受限模型的用户 ID'),
    logLevel: Schema.union([
      Schema.const('simple').description('simple'),
      Schema.const('detail').description('detail'),
    ])
      .default('simple')
      .description('日志级别；simple 记录关键流程，detail 增加脱敏请求诊断'),
  }).description('👑 管理员与权限').collapse(),

  // ⑤ 限流与配额
  Schema.object({
    dailyFreeLimit: Schema.number()
      .default(5)
      .min(1)
      .max(100)
      .step(1)
      .description('普通用户每天可免费生成的次数'),
    unlimitedPlatforms: Schema.array(Schema.string())
      .default(['lark'])
      .description('这些平台跳过每日免费次数限制'),
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
  }).description('🚦 限流与配额').collapse(),

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
  }).description('🛡️ 安全策略').collapse(),

  // ⚙️ 通用设置
  Schema.object({
    showQuotaInImageCommands: Schema.boolean()
      .default(true)
      .description('生成完成后是否显示剩余额度'),
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
  }).description('⚙️ 通用设置').collapse(),
]) as unknown as Schema<Config>
