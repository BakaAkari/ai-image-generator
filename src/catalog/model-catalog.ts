/**
 * 规范化模型目录（Catalog）通用类型
 *
 * 这些类型不依赖任何供应商原始格式，用于在插件内部统一表达
 * 模型、能力、生成路由和可用状态。
 */

/** 激活的供应商 */
export type ActiveSupplier = 'yunwu' | 'gptgod' | 'openai-official' | 'gemini-official'

/** 图像生成能力 */
export type ModelCapability =
  | 'text-to-image'
  | 'image-to-image'
  | 'image-edit'
  | 'image-variation'
  | 'image-upscale'

/** 生成路由的目标协议 */
export type GenerationProtocol = 'openai' | 'gemini' | 'openai-legacy'

/** 模型对于某个协议的具体生成路由 */
export interface GenerationRoute {
  /** 路由标识，同一模型下全局唯一 */
  id: string
  /** 目标协议 */
  protocol: GenerationProtocol
  /** 该路由对应的能力 */
  capability: ModelCapability
  /** 供应商端 endpoint 名称（诊断用） */
  endpointName?: string
}

/** 可执行性判定 */
export type ExecutableStatus = 'available' | 'unavailable' | 'unsupported' | 'unknown'

/** 规范化后的模型信息 */
export interface CatalogModel {
  id: string
  /** 模型类型描述（供应商 model_type 或 fallback） */
  modelType?: string
  description?: string
  /** 该模型声称支持的能力 */
  capabilities: ModelCapability[]
  /** 可用于执行的生成路由 */
  routes: GenerationRoute[]
  /** 该模型可否被调用 */
  executable: boolean
  /** 可执行性状态 */
  executableStatus: ExecutableStatus
  /** 若不可执行，给出原因 */
  unsupportedReasons?: string[]
}

/** 计价类型 */
export type PricingType = 'per-call' | 'per-token' | 'unknown'

/** 规范化计价信息 */
export interface CatalogModelPricing {
  type: PricingType
  /** per-call 单价（美元/次） */
  pricePerCall?: number
  /** per-token 倍率 */
  tokenRatio?: number
  /** 平台分组 */
  enableGroups?: string[]
  /** 计价数据来源 */
  source: 'remote-pricing' | 'remote-models' | 'fallback'
}

/** 规范化目录快照 */
export interface CatalogSnapshot {
  supplier: ActiveSupplier
  /** 快照 schema 版本 */
  schemaVersion: number
  /** 数据解析器版本 */
  parserVersion: string
  /** key 作用域指纹 */
  keyScopeFingerprint: string
  models: CatalogModel[]
  /** 所有解析模型（包含 unsupported） */
  allModels: CatalogModel[]
  fetchedAt: number
  /** 快照生成时的错误（模型信息可能已降级） */
  error?: string
}

/** 模型目录规范化器接口 */
export interface CatalogNormalizer<TRawSnapshot, TSnapshot extends CatalogSnapshot = CatalogSnapshot> {
  /** 规范化原始快照 */
  normalize(raw: TRawSnapshot): TSnapshot
  /** 过滤出可执行模型 */
  executable(snapshot: TSnapshot): CatalogModel[]
  /** 过滤出不可执行/不受支持模型 */
  unsupported(snapshot: TSnapshot): CatalogModel[]
}
