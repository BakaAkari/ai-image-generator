export interface SupplierCredentials {
  apiBase: string
  apiKey: string
  timeoutSec?: number
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface SupplierEndpointResult<T> {
  status: number
  success: boolean
  data?: T
  error?: string
  url?: string
  fetchedAt?: number
}

export interface SupplierRawSnapshot<Endpoints extends Record<string, SupplierEndpointResult<unknown>> = Record<string, SupplierEndpointResult<unknown>>> {
  supplier: string
  fetchedAt: number
  keyScopeFingerprint: string
  endpoints: Endpoints & Record<string, SupplierEndpointResult<unknown>>
}

export interface ImageSupplierAdapter<T extends SupplierRawSnapshot = SupplierRawSnapshot> {
  readonly id: string
  fetchSnapshot(signal?: AbortSignal): Promise<T>
}
