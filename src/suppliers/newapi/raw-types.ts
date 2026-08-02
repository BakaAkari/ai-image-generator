// Raw contract types for new-api compatible platforms (/api/pricing and /v1/models endpoints).
// Keep these structural but permissive: unknown fields are preserved at runtime.

export interface NewApiModelItem {
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

export interface NewApiModelsPayload {
  data: NewApiModelItem[]
  [key: string]: unknown
}

export interface NewApiPricingItem {
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

export interface NewApiPricingPayload {
  data: NewApiPricingItem[]
  [key: string]: unknown
}

export interface NewApiBillingPayload {
  total_usage?: number
  soft_limit_usd?: number
  hard_limit_usd?: number
  token_name?: string
  [key: string]: unknown
}

export interface NewApiStatusPayload {
  // The status endpoint is currently undocumented across new-api forks. Treat as a generic map.
  [key: string]: unknown
}

export interface NewApiRawEndpoints {
  models: import('../types.js').SupplierEndpointResult<NewApiModelsPayload>
  pricing: import('../types.js').SupplierEndpointResult<NewApiPricingPayload>
  billing: import('../types.js').SupplierEndpointResult<NewApiBillingPayload>
  status: import('../types.js').SupplierEndpointResult<NewApiStatusPayload>
}

export type NewApiRawSnapshot = import('../types.js').SupplierRawSnapshot<NewApiRawEndpoints & Record<string, import('../types.js').SupplierEndpointResult<unknown>>>
