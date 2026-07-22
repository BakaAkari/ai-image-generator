// Raw contract types for yunwu.ai /api/pricing and /v1/models endpoints.
// Keep these structural but permissive: unknown fields are preserved at runtime.

export interface YunwuModelItem {
  id: string
  model_type?: string
  description?: string
  supported_endpoint_types?: string[]
  image_ratio?: number
  completion_ratio?: number
  available?: boolean
  type?: number
  tags?: string
  vendor_id?: number
  sort_order?: number
  // Preserve any extra fields returned by the upstream API.
  [key: string]: unknown
}

export interface YunwuModelsPayload {
  data: YunwuModelItem[]
  [key: string]: unknown
}

export interface YunwuPricingItem {
  model_name: string
  quota_type: number
  model_price: number
  model_ratio: number
  enable_groups?: string[]
  description?: string
  model_type?: string
  image_ratio?: number
  completion_ratio?: number
  available?: boolean
  type?: number
  tags?: string
  vendor_id?: number
  sort_order?: number
  // Preserve any extra fields returned by the upstream API.
  [key: string]: unknown
}

export interface YunwuPricingPayload {
  data: YunwuPricingItem[]
  [key: string]: unknown
}

export interface YunwuBillingPayload {
  total_usage?: number
  soft_limit_usd?: number
  hard_limit_usd?: number
  token_name?: string
  [key: string]: unknown
}

export interface YunwuStatusPayload {
  // The yunwu status endpoint is currently undocumented. Treat as a generic map.
  [key: string]: unknown
}

export interface YunwuRawEndpoints {
  models: import('../types.js').SupplierEndpointResult<YunwuModelsPayload>
  pricing: import('../types.js').SupplierEndpointResult<YunwuPricingPayload>
  billing: import('../types.js').SupplierEndpointResult<YunwuBillingPayload>
  status: import('../types.js').SupplierEndpointResult<YunwuStatusPayload>
}

export type YunwuRawSnapshot = import('../types.js').SupplierRawSnapshot<YunwuRawEndpoints & Record<string, import('../types.js').SupplierEndpointResult<unknown>>>
