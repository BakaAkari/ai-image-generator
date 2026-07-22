/**
 * 动态模型目录 — 类型定义
 *
 * 供应商（Supplier）：互斥单选的凭证入口（yunwu / gptgod / openai-official / gemini-official）
 * 目录（Catalog）：从激活供应商拉取的图像模型清单 + 计价信息
 */

export type ActiveSupplier = 'yunwu' | 'gptgod' | 'openai-official' | 'gemini-official'

export interface ImageModelPricing {
  /** per-call = 按次固定价（美元）；per-token = 按 token 倍率 */
  type: 'per-call' | 'per-token' | 'unknown'
  /** per-call 单价（美元/次） */
  pricePerCall?: number
  /** per-token 倍率（相对平台基础价） */
  tokenRatio?: number
  /** 该模型对哪些分组开放（new-api 系） */
  enableGroups?: string[]
}

export interface ImageModelInfo {
  id: string
  /** 从供应商 endpoint 明确解析的可执行路由；不得由模型名推断。 */
  routes: Array<{ id: string; protocol: 'openai' | 'gemini'; capability: string; endpointName?: string }>
  /** 支持的生成模式（按 supported_endpoint_types / 命名推断） */
  modes: Array<'text-to-image' | 'image-to-image' | 'compose-image'>
  description?: string
  pricing: ImageModelPricing
  /** 计价数据来源：remote-pricing 精确 / remote-models 仅清单 / fallback 兜底 */
  source: 'remote-pricing' | 'remote-models' | 'fallback'
}

export interface UnsupportedImageModelInfo {
  id: string
  description?: string
  unsupportedReasons: string[]
}

export interface CatalogSnapshot {
  supplier: ActiveSupplier
  models: ImageModelInfo[]
  unsupportedModels: UnsupportedImageModelInfo[]
  fetchedAt: number
  /** 拉取失败时的错误信息（models 为上次缓存） */
  error?: string
}

/** new-api 系 /v1/models 单项 */
export interface NewApiModelItem {
  id: string
  owned_by?: string
  model_type?: string
  description?: string
  supported_endpoint_types?: string[]
}

/** new-api 系 /api/pricing 单项 */
export interface NewApiPricingItem {
  model_name?: string
  model_id?: string
  id?: string
  model_type?: string
  quota_type?: number
  model_price?: number
  model_ratio?: number
  enable_groups?: string[]
}
