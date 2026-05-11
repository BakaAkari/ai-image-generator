/**
 * V2 共享类型定义（Phase 3 终稿）。
 *
 * 与 v1 的主要差异：
 * - `ProviderType` 改为基于 ProviderRegistry 的强类型 union（不再是 `string` 占位）
 * - 新增 `ProviderCredentials` 标签联合，作为 Tagged Union Schema 在运行期的类型
 * - `ImageProvider`（用作配置选项的字符串字面量）保留，向后兼容 cherry-pick 文件
 *
 * 注意：此处的 `ImageProvider` 与 providers 层的 `ImageProvider` interface 同名但作用不同：
 * - shared/types.ts 中是 **配置选项字符串字面量**（用于 Schema 选择当前 provider）
 * - providers/types.ts 中是 **运行期接口**（generateImages 方法）
 * 两者通过 ProviderRegistry 名字进行映射。
 */

/**
 * V2 已注册的 Provider 名称（与 ProviderRegistry 中 register 的 key 对应）。
 *
 * - openai-images：OpenAI Images API（兼容 yunwu / 官方等多端点）
 * - gemini：Google Gemini 官方 API
 * - gptgod：GPTGod Chat Completions API
 * - grok：xAI Grok Image API（含 yunwu 中转）
 * - yunwu-adaptive：云雾自适应（按 apiFormat 选择 Gemini 或 OpenAI 协议）
 * - gpt-official：OpenAI 官方 GPT Image（继承 openai-images，固定官方 endpoint）
 */
export type ProviderType =
  | 'openai-images'
  | 'openai-chat'
  | 'gemini'
  | 'gptgod'
  | 'grok'
  | 'yunwu-adaptive'
  | 'gpt-official'

/**
 * 配置选项中的「供应商」枚举（Schema 用于 Tagged Union 标签字段）。
 *
 * 与 ProviderType 的差异：这是**用户配置层**的标签，背后映射到一个或多个
 * ProviderRegistry 中的实际 provider 名（例如 'yunwu' 标签 → 'yunwu-adaptive' provider）。
 */
export type ImageProvider = 'yunwu' | 'gptgod' | 'gemini' | 'grok' | 'openai' | 'gpt-official'

/** 兼容站点的协议格式选择 */
export type ApiFormat = 'gemini' | 'openai' | 'openai-chat'

export interface ModelMappingConfig {
  suffix: string
  modelId: string
  provider?: ImageProvider
  apiFormat?: ApiFormat
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
// Tagged Union 凭证类型（Phase 3 新增）
// ----------------------------------------------------------------------------

/**
 * 各供应商分支的凭证 + 模型字段。
 *
 * 与 Schema（shared/config.ts 中的 ProviderConfigSchema）一一对应。
 * 这是 Tagged Union 的运行期类型——每个分支只持有自己用得到的字段，
 * 没有 v1 那种把所有字段都堆在一起再 `.hidden()` 的反模式。
 */

export interface YunwuCredentials {
  provider: 'yunwu'
  apiFormat: ApiFormat
  apiKey: string
  modelId: string
  apiBase: string
}

export interface GptGodCredentials {
  provider: 'gptgod'
  apiKey: string
  modelId: string
}

export interface GeminiCredentials {
  provider: 'gemini'
  apiKey: string
  modelId: string
  apiBase: string
}

export interface GrokCredentials {
  provider: 'grok'
  apiKey: string
  modelId: string
  apiBase: string
}

export interface OpenAICredentials {
  provider: 'openai'
  apiKey: string
  modelId: string
  apiBase: string
}

export interface GptOfficialCredentials {
  provider: 'gpt-official'
  apiKey: string
  modelId: string
  /** 默认 https://api.openai.com，保留可覆盖以适配兼容端点 */
  apiBase: string
}

export type ProviderCredentials =
  | YunwuCredentials
  | GptGodCredentials
  | GeminiCredentials
  | GrokCredentials
  | OpenAICredentials
  | GptOfficialCredentials
