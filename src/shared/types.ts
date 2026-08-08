/**
 * V2 共享类型定义（供应商凭证 + 模型路由统一配置版本）。
 *
 * 配置层供应商只负责凭证：
 * - openai-compatible：第三方 OpenAI-compatible 站点（apiKey + apiBase）
 * - gemini-official：Google Gemini 官方（仅 apiKey，固定 base）
 * - gpt-official：OpenAI 官方 GPT（仅 apiKey，固定 base）
 *
 * 运行时 ProviderRegistry 按协议注册：openai / gemini。
 * 模型映射显式声明 supplier + protocol，系统默认使用第一条映射作为默认模型。
 */

/** V2 已注册的运行时 Provider 名称（与 ProviderRegistry 中 register 的 key 对应）。 */
export type ProviderType = 'openai' | 'gemini' | 'mj'

/** 配置页中的供应商入口（仅用于凭证分区）。 */
export type ImageProvider = 'openai-compatible' | 'gemini-official' | 'gpt-official'


/** 模型映射可覆盖的运行时协议。 */
export type ApiFormat = ProviderType

export interface ModelMappingConfig {
  suffix: string
  modelId: string
  /** @deprecated 0.9.0 起供应商由全局 activeSupplier 统一决定；保留字段以兼容旧配置反序列化 */
  supplier?: ImageProvider
  /** @deprecated 0.9.0 起协议由模型 ID 自动推断（gemini 系 → gemini 协议）；保留字段以兼容旧配置 */
  protocol?: ProviderType
  /** @deprecated 0.5.10 起改名为 protocol；保留读取以兼容 0.5.9 配置 */
  provider?: ProviderType
  /** 是否为受限模型，仅模型白名单内的用户可调用 */
  restricted?: boolean
  /** @deprecated 0.9.0 迁移为 chargePolicy.fixed，保留一版只读兼容。 */
  creditCostPerImage?: number
  /**
   * @deprecated 1.1.1 起改为 ratioOverride（语义更清晰：路由分组倍率覆盖）。
   * 保留字段仅用于旧配置反序列化（Koishi 校验先于 migration 执行，删字段会阻止插件加载）。
   * migration 会清空该字段；运行时不再读取。
   */
  groupRatio?: number
  /**
   * 路由分组倍率覆盖：配置后该模型的预扣与结算直接使用该倍率，不再查 group_ratio 表 / 读响应头。
   * 未配置时按 enable_groups 表上界（预扣）/ 响应头 x-routing-group 命中（结算）/ default 兜底。
   */
  ratioOverride?: number
  /** MJ 等逐 token 计费模型的 token 倍率（实际配置中存在于 mj 映射，类型补全）。 */
  tokenRatio?: number
  /** 覆盖计费策略（如 MJ fixed creditsPerImage）；存在时优先于公式链。 */
  billingPolicy?: { type: 'fixed'; creditsPerImage: number }
}

export interface ImageGenerationModifiers {
  modelMapping?: ModelMappingConfig
  customAdditions?: string[]
  // resolution 支持预设值 (1k/2k/4k) 或自定义尺寸 (如 '1024x2048')
  resolution?: '1k' | '2k' | '4k' | `${number}x${number}`
  aspectRatio?: '1:1' | '4:3' | '16:9' | '9:16' | '3:2' | '2:3'
}

export type StyleMode = 'text-to-image' | 'image-to-image' | 'compose-image'

export interface StyleConfig {
  commandName: string
  description?: string
  prompt: string
  /** 该预设默认走哪条生成链路；为空时兼容旧配置，按 image-to-image 处理。 */
  mode?: StyleMode
  /** 该预设默认使用的模型映射后缀；为空时使用插件默认模型。 */
  modelSuffix?: string
  aliases?: string[]
  keywords?: string[]
  examples?: string[]
  category?: string
  whenToUse?: string
}

export interface StyleGroupConfig {
  prompts: StyleConfig[]
}

export interface ResolvedStyleConfig extends StyleConfig {
  groupName?: string
}

export interface StyleMatchCandidate {
  style: ResolvedStyleConfig
  score: number
  matchedTerms: string[]
}

export interface ImageRequestContext {
  numImages?: number
  /** 供应商凭证入口 */
  supplier?: ImageProvider
  /** 运行时协议通道 */
  provider?: ProviderType
  modelId?: string
  /** 模型映射后缀；用于同一 modelId 存在多条映射时精确定位独立倍率。 */
  modelSuffix?: string
  routeId?: string
  /** 精确契约 id（newapi.openai.gpt-image-2.generate 等）；provider 层由此决定发送形态。 */
  contractId?: string
  /** 本次调用的操作，决定契约选择（text-to-image / image-edit / …）。 */
  operation?: 'text-to-image' | 'image-edit' | 'image-to-image' | 'compose-image'
  apiFormat?: ApiFormat
  // resolution 支持预设值 (1k/2k/4k) 或自定义尺寸 (如 '1024x2048')
  resolution?: '1k' | '2k' | '4k' | `${number}x${number}`
  aspectRatio?: '1:1' | '4:3' | '16:9' | '9:16' | '3:2' | '2:3'
  /**
   * 协议参数规范化产生的 prompt 追加片段（当前用于 MJ `--ar` / `--stylize`）。
   * 由公共层 resolveProtocolParams 生成，orchestrator 在调用 provider 前拼接到 prompt 尾部。
   */
  promptAppends?: string[]
  /**
   * contract-driven 分支解析出的额外字段（openai size/quality、gemini imageSize/aspectRatio、
   * MJ botType 等）。仅存储字段本身，不含 base64/prompt 等敏感值。
   */
  contractFields?: Record<string, string | number>
  /**
   * 用户显式提供但被契约拒绝的参数。存在任何条目时应在计费预授权前 fail-closed。
   */
  rejectedParams?: Array<{ key: string; value: unknown; reason: string }>
}

export interface GenerationDisplayInfo {
  customAdditions?: string[]
  modelId?: string
  modelDescription?: string
}

export interface GeneratedImageRecord {
  id: string
  conversationId: string
  userId: string
  createdAt: number
  source: 'generated' | 'upload' | 'quoted' | 'explicit'
  imageUrl: string
  prompt: string
  normalizedPrompt?: string
  supplier?: ImageProvider
  provider: ProviderType
  modelId: string
  aspectRatio?: string
  resolution?: string
  stylePreset?: string
  parentRecordId?: string
}

export interface ConversationImageContext {
  conversationId: string
  lastGenerated?: GeneratedImageRecord
  recentRecords: GeneratedImageRecord[]
  pinnedStylePreset?: string
  pinnedCharacterNotes?: string
  lastUpdatedAt: number
}

// ----------------------------------------------------------------------------
// 凭证类型
// ----------------------------------------------------------------------------

export interface OpenAICompatibleCredentials {
  provider: 'openai-compatible'
  apiKey: string
  apiBase: string
  extraHeaders?: Record<string, string>
}

export interface GeminiOfficialCredentials {
  provider: 'gemini-official'
  apiKey: string
}

export interface GptOfficialCredentials {
  provider: 'gpt-official'
  apiKey: string
}

export type ProviderCredentials =
  | OpenAICompatibleCredentials
  | GeminiOfficialCredentials
  | GptOfficialCredentials

