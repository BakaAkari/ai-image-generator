/**
 * 动态模型目录 — 类型定义
 *
 * 供应商（Supplier）：互斥单选的凭证入口（newapi / openai-official / gemini-official）
 * 目录（Catalog）：从激活供应商拉取的图像模型清单 + 计价信息
 */

export type ActiveSupplier = 'newapi' | 'openai-official' | 'gemini-official'

export interface ImageModelPricing {
  /** per-call = 按次固定供应商积分；per-token = 按 token 倍率 */
  type: 'per-call' | 'per-token' | 'unknown'
  /** per-call 单价（供应商积分/次；new-api 语义下 1 供应商积分 = ¥0.5） */
  pricePerCall?: number
  /** per-token 倍率（相对平台基础价） */
  tokenRatio?: number
  /** 该模型对哪些分组开放（new-api 系） */
  enableGroups?: string[]
}

export interface ImageModelInfo {
  id: string
  /** 从供应商 endpoint 明确解析的可执行路由；不得由模型名推断。 */
  routes: Array<{ id: string; protocol: 'openai' | 'gemini' | 'mj'; capability: string; endpointName?: string }>
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
  groupRatio?: Record<string, number>
  /** 拉取失败时的错误信息（models 为上次缓存） */
  error?: string
}
