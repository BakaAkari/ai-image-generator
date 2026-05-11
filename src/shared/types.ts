/**
 * V2 共享类型定义（供应商语义 + 协议路由版本）。
 *
 * 配置层只暴露用户可理解的三类供应商入口：
 * - openai-compatible：第三方 OpenAI-compatible 站点，通过接口格式选择具体协议。
 * - openai-official：OpenAI 官方 Images API。
 * - gemini-official：Google Gemini 官方原生接口。
 *
 * 运行时 ProviderRegistry 仍按协议 / 通道注册：openai-images / openai-chat / gemini。
 */

/** V2 已注册的运行时 Provider 名称（与 ProviderRegistry 中 register 的 key 对应）。 */
export type ProviderType = 'openai-images' | 'openai-chat' | 'gemini'

/** 配置页中的顶层供应商入口。 */
export type ImageProvider = 'openai-compatible' | 'openai-official' | 'gemini-official'

/** OpenAI-compatible 站点可选择的接口格式。 */
export type OpenAICompatibleProtocol = 'openai-images' | 'openai-chat'

/** 模型映射可覆盖的运行时协议 / 通道。 */
export type ApiFormat = ProviderType

export interface ModelMappingConfig {
  suffix: string
  modelId: string
  provider?: ProviderType
  /** 是否为受限模型，仅模型白名单内的用户可调用 */
  restricted?: boolean
}

export interface ImageGenerationModifiers {
  modelMapping?: ModelMappingConfig
  customAdditions?: string[]
  // resolution 支持预设值 (1k/2k/4k) 或自定义尺寸 (如 '1024x2048')
  resolution?: '1k' | '2k' | '4k' | `${number}x${number}`
  aspectRatio?: '1:1' | '4:3' | '16:9' | '9:16' | '3:2' | '2:3'
}

export interface StyleConfig {
  commandName: string
  description?: string
  prompt: string
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
  protocol: OpenAICompatibleProtocol
  apiKey: string
  modelId: string
  apiBase: string
  extraHeaders?: Record<string, string>
}

export interface OpenAIOfficialCredentials {
  provider: 'openai-official'
  apiKey: string
  modelId: string
  apiBase: string
}

export interface GeminiOfficialCredentials {
  provider: 'gemini-official'
  apiKey: string
  modelId: string
  apiBase: string
}

export type ProviderCredentials =
  | OpenAICompatibleCredentials
  | OpenAIOfficialCredentials
  | GeminiOfficialCredentials
