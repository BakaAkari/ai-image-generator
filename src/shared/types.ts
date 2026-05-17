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
export type ProviderType = 'openai' | 'gemini'

/** 配置页中的供应商入口（仅用于凭证分区）。 */
export type ImageProvider = 'openai-compatible' | 'gemini-official' | 'gpt-official'


/** 模型映射可覆盖的运行时协议。 */
export type ApiFormat = ProviderType

export interface ModelMappingConfig {
  suffix: string
  modelId: string
  /** 供应商凭证入口：openai-compatible / gemini-official / gpt-official */
  supplier?: ImageProvider
  /** 运行时协议：openai / gemini */
  protocol?: ProviderType
  /** @deprecated 0.5.10 起改名为 protocol；保留读取以兼容 0.5.9 配置 */
  provider?: ProviderType
  /** 是否为受限模型，仅模型白名单内的用户可调用 */
  restricted?: boolean
  /** 0.6.0 积分制：该模型每张图片向用户收取的积分；支持小数，为空则使用全局默认单价。 */
  creditCostPerImage?: number
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
  apiFormat?: ApiFormat
  // resolution 支持预设值 (1k/2k/4k) 或自定义尺寸 (如 '1024x2048')
  resolution?: '1k' | '2k' | '4k' | `${number}x${number}`
  aspectRatio?: '1:1' | '4:3' | '16:9' | '9:16' | '3:2' | '2:3'
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
