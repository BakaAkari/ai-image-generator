/**
 * V2 配置 Schema —— image-only，供应商语义 + 协议路由版本。
 *
 * 设计要点：
 * - 控制台顶层只暴露“OpenAI 兼容 / OpenAI 官方 / Gemini 官方”三类供应商入口。
 * - 第三方聚合站统一走 OpenAI-compatible 配置：baseUrl + apiKey + model + protocol。
 * - OpenAI-compatible 内部再选择具体接口格式：
 *   ① OpenAI Images API：GPT-image 类模型
 *   ② OpenAI Chat Completions 多模态：Gemini Banana / Nano Banana 类模型
 * - 所有数值配置使用数字输入，不使用滑竿。
 */
import { Schema } from 'koishi'
import type {
  ImageProvider,
  ModelMappingConfig,
  OpenAICompatibleProtocol,
  StyleConfig,
  StyleGroupConfig,
} from './types.js'

// ----------------------------------------------------------------------------
// 运行期 Config interface
// ----------------------------------------------------------------------------

export interface Config {
  // ── ① 供应商入口 ─────────────────────────────────────────────────────────────
  provider: ImageProvider

  // OpenAI-compatible 第三方站点
  openaiCompatibleProtocol?: OpenAICompatibleProtocol
  openaiCompatibleApiKey?: string
  openaiCompatibleModelId?: string
  openaiCompatibleApiBase?: string
  openaiCompatibleExtraHeaders?: Record<string, string>

  // OpenAI 官方 Images API
  openaiOfficialApiKey?: string
  openaiOfficialModelId?: string
  openaiOfficialApiBase?: string

  // Gemini 官方原生接口
  geminiOfficialApiKey?: string
  geminiOfficialModelId?: string
  geminiOfficialApiBase?: string

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
  logLevel: 'info' | 'debug'

  // ── 通用 ──────────────────────────────────────────────────────────────────
  apiTimeout: number
}

// ----------------------------------------------------------------------------
// 子 Schema
// ----------------------------------------------------------------------------

const StyleItemSchema = Schema.object({
  commandName: Schema.string()
    .required()
    .description('命令名称')
    .role('table-cell', { width: 30 }),
  description: Schema.string()
    .role('textarea', { rows: 2 })
    .description('指令描述（一句话概括用途）'),
  prompt: Schema.string()
    .role('textarea', { rows: 6 })
    .required()
    .description('完整的生成 prompt'),
})

const ProviderSchema = Schema.object({
  provider: Schema.union([
    Schema.const('openai-compatible').description('OpenAI 兼容（第三方站点）'),
    Schema.const('openai-official').description('OpenAI 官方'),
    Schema.const('gemini-official').description('Gemini 官方'),
  ])
    .default('openai-compatible')
    .description('图像生成供应商。此处只选择顶层语义供应商；下方只填写当前供应商对应的配置组'),
}).description('🎨 图像供应商')

const OpenAICompatibleSchema = Schema.object({
  openaiCompatibleProtocol: Schema.union([
    Schema.const('openai-images').description('GPT-image / Images API'),
    Schema.const('openai-chat').description('Gemini Banana / Chat Completions 多模态'),
  ])
    .default('openai-images')
    .description('OpenAI 兼容接口格式。仅当供应商选择“OpenAI 兼容”时生效'),
  openaiCompatibleApiKey: Schema.string()
    .role('secret')
    .default('')
    .description('第三方 OpenAI-compatible 站点 API 密钥。仅当供应商选择“OpenAI 兼容”时生效'),
  openaiCompatibleModelId: Schema.string()
    .default('gpt-image-2')
    .description('第三方站点模型 ID，例如 gpt-image-2 / gemini-2.5-flash-image'),
  openaiCompatibleApiBase: Schema.string()
    .default('https://api.openai.com/v1')
    .description('第三方站点 API 地址。未包含 /v1 时会自动补齐'),
  openaiCompatibleExtraHeaders: Schema.dict(Schema.string())
    .default({})
    .description('第三方站点额外请求头。如需 User-Agent 等可在这里填写'),
}).description('🔌 OpenAI 兼容设置').collapse()

const OpenAIOfficialSchema = Schema.object({
  openaiOfficialApiKey: Schema.string()
    .role('secret')
    .default('')
    .description('OpenAI 官方 API 密钥。仅当供应商选择“OpenAI 官方”时生效'),
  openaiOfficialModelId: Schema.string()
    .default('gpt-image-2')
    .description('OpenAI Images 模型 ID，例如 gpt-image-2 / gpt-image-1'),
  openaiOfficialApiBase: Schema.string()
    .default('https://api.openai.com/v1')
    .description('OpenAI 官方 API 地址'),
}).description('🏢 OpenAI 官方设置').collapse()

const GeminiOfficialSchema = Schema.object({
  geminiOfficialApiKey: Schema.string()
    .role('secret')
    .default('')
    .description('Google Gemini API 密钥。仅当供应商选择“Gemini 官方”时生效'),
  geminiOfficialModelId: Schema.string()
    .default('gemini-2.5-flash-image')
    .description('Gemini 模型 ID'),
  geminiOfficialApiBase: Schema.string()
    .default('https://generativelanguage.googleapis.com')
    .description('Gemini API 地址'),
}).description('🔷 Gemini 官方设置').collapse()

// ----------------------------------------------------------------------------
// 顶层 Schema
// ----------------------------------------------------------------------------

export const Config = Schema.intersect([
  // ① 图像供应商（稳定展示结构：选择项 + 各供应商配置组）
  ProviderSchema,
  OpenAICompatibleSchema,
  OpenAIOfficialSchema,
  GeminiOfficialSchema,

  // ② 图像生成（风格预设 + 显示设置）
  Schema.object({
    styles: Schema.array(StyleItemSchema)
      .role('table')
      .default([
        {
          commandName: '变手办',
          description: '图像风格转换',
          prompt:
            '将这张照片变成手办模型。在它后面放置一个印有图像主体的盒子，桌子上有一台电脑显示Blender建模过程。在盒子前面添加一个圆形塑料底座，角色手办站在上面。如果可能的话，将场景设置在室内',
        },
        {
          commandName: '变写实',
          description: '图像风格转换',
          prompt:
            '请根据用户提供的图片，在严格保持主体身份、外观特征与姿态不变的前提下，生成一张照片级真实感的超写实摄影作品。要求：1. 采用专业相机拍摄（如佳能EOS R5），使用85mm f/1.4人像镜头；2. 画面应具有照片级真实感、超现实主义风格和高细节表现；3. 使用自然光影营造真实氛围；4. 整体效果需像专业摄影棚拍摄的真实照片。',
        },
      ])
      .description('自定义风格命令配置（建议：description 概括效果，prompt 写细节）'),
    styleGroups: Schema.dict(
      Schema.object({
        prompts: Schema.array(StyleItemSchema)
          .role('table')
          .default([])
          .description('该分组下的风格预设。同样建议 description 概括效果、prompt 写细节'),
      })
    )
      .role('table')
      .default({})
      .description('按类型管理的 prompt 组，键名即为分组名称'),
    showQuotaInImageCommands: Schema.boolean()
      .default(true)
      .description('生成完成后是否附带剩余额度提示'),
    defaultNumImages: Schema.number()
      .default(1)
      .min(1)
      .max(4)
      .step(1)
      .description('默认生成图片数量'),
  }).description('🖼️ 图像生成').collapse(),

  // ③ 模型映射
  Schema.object({
    modelMappings: Schema.array(
      Schema.object({
        suffix: Schema.string().required().description('切换模型参数后缀名（如 -pro）'),
        modelId: Schema.string().required().description('对应的模型 ID'),
        provider: Schema.union([
          Schema.const('openai-images').description('OpenAI Images API'),
          Schema.const('openai-chat').description('OpenAI Chat Completions 多模态'),
          Schema.const('gemini').description('Google Gemini 官方'),
        ])
          .default('openai-images')
          .description('该映射对应的运行时协议 / 通道'),
        restricted: Schema.boolean()
          .default(false)
          .description('是否为受限模型（仅模型白名单用户可调用）'),
      }).collapse()
    )
      .role('table')
      .default([])
      .description('根据 -后缀切换模型映射。例如：「-pro」自动切到指定模型和协议'),
  }).description('🔀 模型映射').collapse(),

  // ④ 限流与配额
  Schema.object({
    dailyFreeLimit: Schema.number()
      .default(5)
      .min(1)
      .max(100)
      .step(1)
      .description('每日免费调用次数'),
    unlimitedPlatforms: Schema.array(Schema.string())
      .default(['lark'])
      .description('不受配额限制的平台列表（如 lark / onebot / discord 等）'),
    rateLimitWindow: Schema.number()
      .default(300)
      .min(60)
      .max(3600)
      .step(30)
      .description('限流时间窗口（秒）'),
    rateLimitMax: Schema.number()
      .default(3)
      .min(1)
      .max(20)
      .step(1)
      .description('限流窗口内最大调用次数'),
  }).description('🚦 限流与配额'),

  // ⑤ 安全策略
  Schema.object({
    securityBlockWindow: Schema.number()
      .default(600)
      .min(60)
      .max(3600)
      .step(60)
      .description('安全策略拦截追踪时间窗口（秒）'),
    securityBlockWarningThreshold: Schema.number()
      .default(3)
      .min(1)
      .max(10)
      .step(1)
      .description('安全策略拦截警示阈值，连续触发后将发送警示'),
  }).description('🛡️ 安全策略'),

  // ⑥ 管理员设置
  Schema.object({
    adminUsers: Schema.array(Schema.string())
      .default([])
      .description('管理员用户 ID 列表（拥有所有权限，不受限制）'),
    permanentMembers: Schema.array(Schema.string())
      .default([])
      .description('永久会员用户 ID 列表（无限量使用图像生成，不受每日配额和限流限制）'),
    modelWhitelistUsers: Schema.array(Schema.string())
      .default([])
      .description('模型白名单用户 ID 列表（可调用「受限」模型）'),
    logLevel: Schema.union([
      Schema.const('info').description('普通信息'),
      Schema.const('debug').description('完整 debug 信息'),
    ])
      .default('info')
      .description('日志输出详细程度'),
  }).description('👑 管理员设置').collapse(),

  // ⚙️ 通用设置
  Schema.object({
    apiTimeout: Schema.number()
      .default(60)
      .min(10)
      .max(600)
      .step(10)
      .description('API 请求超时时间（秒）'),
  }).description('⚙️ 通用设置').collapse(),
]) as unknown as Schema<Config>
