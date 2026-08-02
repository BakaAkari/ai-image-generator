/**
 * 契约层类型（Contract Layer）。
 *
 * 契约（Contract）= 供应商 + 协议 + 具体操作（text-to-image / image-edit / …）+
 * 具体请求方言（endpoint、method、content-type）+ 明确的字段能力集合。
 *
 * 一次生成请求需要精确定位到唯一 contract，才能：
 * - 生成合法请求体；
 * - 决定哪些用户参数被采纳、哪些应报错；
 * - 决定缺失参数的默认值。
 */

/** 具体的生成操作类别。 */
export type ContractOperation =
  | 'text-to-image'
  | 'image-edit'
  | 'image-to-image'
  | 'compose-image'

/** 生成请求真正打到的协议通道（复用旧类型语义）。 */
export type ContractProtocol = 'openai' | 'gemini' | 'mj'

/** 供应商（凭证入口）。契约层用此区分方言，不做鉴权。 */
export type ContractSupplier =
  | 'newapi' // new-api 兼容站（OpenAI-compatible + Gemini 兼容 + MJ 兼容）
  | 'openai-official' // OpenAI 官方
  | 'gemini-official' // Google Gemini 官方

/** 用户在插件层面统一暴露的分辨率等级（不代表契约支持）。 */
export type UserResolutionLevel = '1k' | '2k' | '4k'

/** 用户在插件层面统一暴露的宽高比。 */
export type UserAspectRatio = '1:1' | '4:3' | '16:9' | '9:16' | '3:2' | '2:3'

/** OpenAI 契约的自定义尺寸限制。 */
export interface OpenAiCustomSizeLimits {
  maxSide: number
  /** 边像素倍数（GPT Image 2 = 16）。 */
  step: number
  /** 长边 / 短边最大比。 */
  maxRatio: number
  minPixels: number
  maxPixels: number
}

/** OpenAI 尺寸能力（仅在 protocol=openai 使用）。 */
export interface OpenAiSizeCapability {
  /** 固定 size 枚举，如 '1024x1024'。 */
  fixedSizes: string[]
  /** 供 aspectRatio+resolutionLevel 精确落位到固定 size 的映射。 */
  fixedByResolutionAndAspect?: Partial<Record<UserResolutionLevel, Partial<Record<UserAspectRatio, string>>>>
  /** 是否允许 `数字x数字` 自定义尺寸，及其限制。 */
  customSizeLimits?: OpenAiCustomSizeLimits
  /** 是否接受 'auto'。 */
  supportsAuto?: boolean
}

/** Gemini 契约的 imageConfig 能力。 */
export interface GeminiImageConfigCapability {
  /** 是否发送 imageConfig；false 时永不发送。 */
  enabled: boolean
  /** 支持的 aspectRatio 枚举；空数组等价于任意（不校验）。 */
  aspectRatios?: UserAspectRatio[]
  /** 支持的 imageSize 大写枚举（如 '1K' / '2K' / '4K'）。 */
  imageSizes?: string[]
  /** 若为 true，未提供分辨率时缺省不发送 imageSize 字段。 */
  imageSizeOptional?: boolean
}

/** MJ 契约的能力（Imagine 主链路）。 */
export interface MjImagineCapability {
  /** 是否支持 --ar 后缀，允许列表用 UserAspectRatio 枚举。 */
  supportsAspectRatio: boolean
  /** 支持的 aspectRatio 枚举。 */
  aspectRatios?: UserAspectRatio[]
  /** 是否支持 --stylize（若为 false，用户显式 stylize 应报错）。 */
  supportsStylize: boolean
  stylizeMin?: number
  stylizeMax?: number
  /** botType 枚举。默认 MID_JOURNEY。 */
  botTypes?: Array<'MID_JOURNEY' | 'NIJI_JOURNEY'>
  /** 是否允许 base64Array 垫图。 */
  supportsBase64ReferenceImages?: boolean
}

export interface OpenAiOpCapability {
  size?: OpenAiSizeCapability
  /** 是否支持 n 字段。false 时用户显式 n>1 应报错。 */
  supportsN: boolean
  /** 可接受的 n 上限（协议层）。默认 1。 */
  maxN?: number
  /** quality 枚举，未提供表示不支持发送。 */
  qualities?: string[]
  /** format 枚举，未提供表示不支持发送。 */
  formats?: string[]
  /** background 枚举。 */
  backgrounds?: string[]
  /** moderation 枚举。 */
  moderations?: string[]
  /** response_format 枚举（如 'url', 'b64_json'）。 */
  responseFormats?: string[]
  /** 请求内容类型：默认 JSON；image-edit 通常为 multipart。 */
  contentType?: 'application/json' | 'multipart/form-data'
  /** 编辑操作是否需要参考图。 */
  requiresReferenceImage?: boolean
}

export interface GeminiOpCapability {
  imageConfig: GeminiImageConfigCapability
  /** responseModalities 默认组。默认 ['TEXT','IMAGE']。 */
  responseModalities?: string[]
  /** 是否支持云雾 response_format=url 扩展。 */
  supportsYunwuResponseFormatUrl?: boolean
  /** 是否需要参考图。 */
  requiresReferenceImage?: boolean
}

/** 图像生成契约。 */
export interface ImageContract {
  /** 全局唯一契约 ID，形如 `newapi.openai.gpt-image-2.generate` / `newapi.mj.imagine`。 */
  id: string
  supplier: ContractSupplier
  protocol: ContractProtocol
  operation: ContractOperation
  /** 生成请求相对 apiBase 的路径（含前导 `/`）。 */
  endpoint: string
  method: 'POST' | 'GET'
  /** 契约打到的具体模型 id（catalog 侧 id）。'*' 表示与该协议匹配的任意模型。 */
  modelIds: string[] | '*'
  /** 协议专属能力。OpenAI / Gemini / MJ 三选一填写。 */
  openai?: OpenAiOpCapability
  gemini?: GeminiOpCapability
  mj?: MjImagineCapability
  /** 简短描述，日志与错误消息用。 */
  label?: string
}

export interface ContractResolveInput {
  modelId: string
  supplier: ContractSupplier
  protocol: ContractProtocol
  operation: ContractOperation
}

export type ContractResolveResult =
  | { ok: true; contract: ImageContract }
  | { ok: false; reason: string }
