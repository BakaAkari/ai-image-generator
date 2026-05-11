/**
 * V2 配置 Schema —— Phase 3 Batch D 终稿（image-only）。
 *
 * 设计要点：
 * - **Tagged Union**：`Schema.intersect([base, Schema.union([...])])`，每个分支只声明自己用到的字段，
 *   不再使用 v1 的 `.hidden()` 反模式。
 * - **范围**：仅图像生成。所有视频相关字段 / Schema 已移除。
 * - **运行期类型**：`Config` interface 与 Schema 保持一致；可被 v1 的 cherry-pick 文件
 *   （UserManager / prompt-timeout）继续使用。
 *
 * 顶层布局（按用户视觉优先级排序）：
 *   ① 图像供应商（Tagged Union 主体）
 *   ② 图像生成（风格预设 styles + styleGroups + 基础显示设置）
 *   ③ 模型映射
 *   ④ 限流与配额
 *   ⑤ 安全策略
 *   ⑥ 管理员设置
 *   ⑦ ChatLuna 集成
 */
import { Schema } from 'koishi'
import type {
  ApiFormat,
  ImageProvider,
  ModelMappingConfig,
  StyleConfig,
  StyleGroupConfig,
} from './types.js'

// ----------------------------------------------------------------------------
// 运行期 Config interface
// ----------------------------------------------------------------------------

export interface Config {
  // ── ① 供应商（Tagged Union 标签 + 各分支字段，每个分支仅持有该供应商需要的字段）─
  provider: ImageProvider

  // 云雾分支
  yunwuApiKey?: string
  yunwuModelId?: string
  yunwuApiFormat?: ApiFormat
  yunwuApiBase?: string

  // GPTGod 分支
  gptgodApiKey?: string
  gptgodModelId?: string

  // Gemini 官方分支
  geminiApiKey?: string
  geminiModelId?: string
  geminiApiBase?: string

  // Grok 分支（默认通过云雾中转）
  grokApiKey?: string
  grokModelId?: string
  grokApiBase?: string

  // OpenAI 兼容分支
  openaiApiKey?: string
  openaiModelId?: string
  openaiApiBase?: string
  openaiProtocol?: 'openai-images' | 'openai-chat'
  openaiExtraHeaders?: Record<string, string>

  // 官方 GPT Image 分支
  gptOfficialApiKey?: string
  gptOfficialModelId?: string
  gptOfficialApiBase?: string

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

  // ── ⑦ ChatLuna 集成 ───────────────────────────────────────────────────────
  chatlunaEnabled: boolean
  chatlunaContextInjectionEnabled: boolean
  chatlunaContextHistorySize: number
  chatlunaContextTtlSeconds: number

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

// ① 供应商标签 —— Tagged Union 入口（与下方各分支的 provider const 对应）
const ProviderTagSchema = Schema.object({
  provider: Schema.union([
    Schema.const('yunwu').description('云雾（自适应：Gemini / OpenAI 协议）'),
    Schema.const('gptgod').description('GPT God'),
    Schema.const('gemini').description('Google Gemini 官方'),
    Schema.const('grok').description('Grok (xAI，可经云雾中转)'),
    Schema.const('openai').description('OpenAI 兼容第三方图像站点'),
    Schema.const('gpt-official').description('OpenAI 官方 GPT Image'),
  ])
    .default('yunwu')
    .description('图像生成供应商'),
}).description('🎨 图像供应商')

// ① 供应商分支 —— 每个分支只声明自己需要的字段（零 .hidden()）
const ProviderConfigSchema = Schema.union([
  // 云雾自适应
  Schema.object({
    provider: Schema.const('yunwu').required(),
    yunwuApiKey: Schema.string()
      .role('secret')
      .required()
      .description('云雾 API 密钥'),
    yunwuModelId: Schema.string()
      .default('gemini-2.5-flash-image')
      .description('云雾默认模型ID（按所选 apiFormat 选择对应模型）'),
    yunwuApiFormat: Schema.union([
      Schema.const('gemini').description('Gemini 原生协议'),
      Schema.const('openai').description('OpenAI Images / GPT-Image 协议'),
    ])
      .default('gemini')
      .description('接口格式（决定 yunwu-adaptive 内部委托给哪个 Provider）'),
    yunwuApiBase: Schema.string()
      .default('https://yunwu.ai')
      .description('云雾 API 地址'),
  }),

  // GPTGod
  Schema.object({
    provider: Schema.const('gptgod').required(),
    gptgodApiKey: Schema.string()
      .role('secret')
      .required()
      .description('GPT God API 密钥'),
    gptgodModelId: Schema.string()
      .default('')
      .description('GPT God 模型ID（留空使用账号默认）'),
  }),

  // Gemini 官方
  Schema.object({
    provider: Schema.const('gemini').required(),
    geminiApiKey: Schema.string()
      .role('secret')
      .required()
      .description('Google Gemini API 密钥'),
    geminiModelId: Schema.string()
      .default('gemini-2.5-flash-image')
      .description('Gemini 模型ID'),
    geminiApiBase: Schema.string()
      .default('https://generativelanguage.googleapis.com')
      .description('Gemini API 地址'),
  }),

  // Grok
  Schema.object({
    provider: Schema.const('grok').required(),
    grokApiKey: Schema.string()
      .role('secret')
      .required()
      .description('Grok API 密钥（可使用云雾中转）'),
    grokModelId: Schema.string()
      .default('grok-3-image')
      .description('Grok 图像模型ID'),
    grokApiBase: Schema.string()
      .default('https://yunwu.ai')
      .description('Grok API 地址（默认云雾中转）'),
  }),

  // OpenAI 兼容
  Schema.object({
    provider: Schema.const('openai').required(),
    openaiApiKey: Schema.string()
      .role('secret')
      .required()
      .description('OpenAI 兼容 API 密钥'),
    openaiModelId: Schema.string()
      .default('gpt-image-2')
      .description('模型ID，例如 gpt-image-2 或 Gemini/Banana 兼容模型'),
    openaiApiBase: Schema.string()
      .default('https://api.openai.com/v1')
      .description('API 地址，建议填写到 /v1；未包含 /v1 时会自动补齐'),
    openaiProtocol: Schema.union([
      Schema.const('openai-images').description('GPT 图片接口（/v1/images/generations、/v1/images/edits）'),
      Schema.const('openai-chat').description('Gemini/Banana 多模态接口（/v1/chat/completions）'),
    ])
      .default('openai-images')
      .description('接口格式'),
    openaiExtraHeaders: Schema.dict(Schema.string())
      .default({})
      .description('额外请求头。米醋等站点如需 User-Agent，可在这里填写'),
  }),

  // GPT 官方
  Schema.object({
    provider: Schema.const('gpt-official').required(),
    gptOfficialApiKey: Schema.string()
      .role('secret')
      .required()
      .description('OpenAI 官方 API 密钥'),
    gptOfficialModelId: Schema.string()
      .default('gpt-image-1')
      .description('官方 GPT Image 模型ID'),
    gptOfficialApiBase: Schema.string()
      .default('https://api.openai.com/v1')
      .description('OpenAI 官方 API 地址（一般无需修改）'),
  }),
])

// ----------------------------------------------------------------------------
// 顶层 Schema
// ----------------------------------------------------------------------------

export const Config = Schema.intersect([
  // ① 图像供应商（标签 + 分支）
  ProviderTagSchema,
  ProviderConfigSchema,

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
      .description('是否在「图像指令」列表中显示「图像额度」指令（仅影响列表显示）'),
    defaultNumImages: Schema.number()
      .default(1)
      .min(1)
      .max(4)
      .step(1)
      .role('slider')
      .description('默认生成图片数量'),
  }).description('🖼️ 图像生成').collapse(),

  // ③ 模型映射
  Schema.object({
    modelMappings: Schema.array(
      Schema.object({
        suffix: Schema.string().required().description('切换模型参数后缀名（如 -pro）'),
        modelId: Schema.string().required().description('对应的模型ID'),
        provider: Schema.union([
          Schema.const('yunwu').description('云雾'),
          Schema.const('gptgod').description('GPT God'),
          Schema.const('gemini').description('Google Gemini'),
          Schema.const('grok').description('Grok (xAI)'),
          Schema.const('openai').description('OpenAI 兼容'),
          Schema.const('gpt-official').description('OpenAI 官方'),
        ])
          .default('yunwu')
          .description('该映射对应的供应商'),
        apiFormat: Schema.union([
          Schema.const('gemini').description('Gemini 原生'),
          Schema.const('openai').description('OpenAI Images / GPT-Image'),
          Schema.const('openai-chat').description('OpenAI Chat Completions 多模态'),
        ])
          .default('gemini')
          .description('接口格式（yunwu 供应商使用 gemini/openai；openai 兼容站点可使用 openai/openai-chat）'),
        restricted: Schema.boolean()
          .default(false)
          .description('是否为受限模型（仅模型白名单用户可调用）'),
      }).collapse()
    )
      .role('table')
      .default([])
      .description('根据 -后缀切换模型映射。例如：「-pro」自动切到指定模型'),
  }).description('🔀 模型映射').collapse(),

  // ④ 限流与配额
  Schema.object({
    dailyFreeLimit: Schema.number()
      .default(5)
      .min(1)
      .max(100)
      .step(1)
      .role('slider')
      .description('每日免费调用次数'),
    unlimitedPlatforms: Schema.array(Schema.string())
      .default(['lark'])
      .description('不受配额限制的平台列表（如 lark / onebot / discord 等）'),
    rateLimitWindow: Schema.number()
      .default(300)
      .min(60)
      .max(3600)
      .step(30)
      .role('slider')
      .description('限流时间窗口（秒）'),
    rateLimitMax: Schema.number()
      .default(3)
      .min(1)
      .max(20)
      .step(1)
      .role('slider')
      .description('限流窗口内最大调用次数'),
  }).description('🚦 限流与配额'),

  // ⑤ 安全策略
  Schema.object({
    securityBlockWindow: Schema.number()
      .default(600)
      .min(60)
      .max(3600)
      .step(60)
      .role('slider')
      .description('安全策略拦截追踪时间窗口（秒）'),
    securityBlockWarningThreshold: Schema.number()
      .default(3)
      .min(1)
      .max(10)
      .step(1)
      .role('slider')
      .description('安全策略拦截警示阈值，连续触发后将发送警示'),
  }).description('🛡️ 安全策略'),

  // ⑥ 管理员设置
  Schema.object({
    adminUsers: Schema.array(Schema.string())
      .default([])
      .description('管理员用户ID列表（拥有所有权限，不受限制）'),
    permanentMembers: Schema.array(Schema.string())
      .default([])
      .description('永久会员用户ID列表（无限量使用图像生成，不受每日配额和限流限制）'),
    modelWhitelistUsers: Schema.array(Schema.string())
      .default([])
      .description('模型白名单用户ID列表（可调用「受限」模型）'),
    logLevel: Schema.union([
      Schema.const('info').description('普通信息'),
      Schema.const('debug').description('完整 debug 信息'),
    ])
      .default('info')
      .description('日志输出详细程度'),
  }).description('👑 管理员设置').collapse(),

  // ⑦ ChatLuna 集成
  Schema.object({
    chatlunaEnabled: Schema.boolean()
      .default(false)
      .description('是否启用内置 ChatLuna 工具桥接（开启后会尝试把图像能力注册到 ChatLuna）'),
    chatlunaContextInjectionEnabled: Schema.boolean()
      .default(true)
      .description('是否在 ChatLuna 对话前注入最近一次图像生成上下文'),
    chatlunaContextHistorySize: Schema.number()
      .default(20)
      .min(1)
      .max(50)
      .step(1)
      .role('slider')
      .description('每个 ChatLuna 会话保留的最近图像上下文数量'),
    chatlunaContextTtlSeconds: Schema.number()
      .default(86400)
      .min(300)
      .max(2592000)
      .step(300)
      .role('slider')
      .description('ChatLuna 图像上下文缓存保留时长（秒）'),
  }).description('🌙 ChatLuna 集成').collapse(),

  // ⚙️ 通用设置
  Schema.object({
    apiTimeout: Schema.number()
      .default(60)
      .min(10)
      .max(600)
      .step(10)
      .role('slider')
      .description('API 请求超时时间（秒）'),
  }).description('⚙️ 通用设置').collapse(),
]) as unknown as Schema<Config>
