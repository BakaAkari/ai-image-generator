import { createHash } from 'crypto'
import type { SupplierCredentials, FetchLike, SupplierRawSnapshot, ImageSupplierAdapter } from '../types.js'
import type {
  NewApiBillingPayload,
  NewApiModelsPayload,
  NewApiPricingPayload,
  NewApiRawEndpoints,
  NewApiStatusPayload,
} from './raw-types.js'

export interface SupplierEndpointsConfig {
  models?: string
  pricing?: string
  usage?: string
  usageQuery?: Record<string, string>
  subscription?: string
}

export interface NewApiClientConfig extends SupplierCredentials {
  endpoints?: SupplierEndpointsConfig
}

export interface KeyScopeMaterial {
  supplier: string
  apiBase: string
  apiKey: string
}

const SUPPLIER = 'newapi'

function normalizeApiBase(apiBase: string): string {
  const trimmed = apiBase.trim().replace(/\/$/, '')
  if (trimmed.endsWith('/v1')) {
    return trimmed.slice(0, -3)
  }
  return trimmed
}

export function createKeyScopeFingerprint(material: KeyScopeMaterial): string {
  const h = createHash('sha256')
  h.update(`${material.supplier}:${normalizeApiBase(material.apiBase)}:${material.apiKey}`)
  return h.digest('hex').slice(0, 16)
}

export class NewApiClient implements ImageSupplierAdapter<SupplierRawSnapshot<NewApiRawEndpoints & Record<string, import('../types.js').SupplierEndpointResult<unknown>>>> {
  readonly id = SUPPLIER
  private readonly apiBase: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly fetchLike: FetchLike
  private readonly extraHeaders: Record<string, string>
  private readonly endpoints: Required<Omit<SupplierEndpointsConfig, 'usageQuery'>> & { usageQuery: Record<string, string> }

  constructor(
    config: NewApiClientConfig,
    fetchLike: FetchLike = globalThis.fetch.bind(globalThis)
  ) {
    this.apiBase = normalizeApiBase(config.apiBase)
    this.apiKey = config.apiKey
    this.timeoutMs = (config.timeoutSec ?? 30) * 1000
    this.fetchLike = fetchLike
    this.extraHeaders = { ...(config.extraHeaders ?? {}) }
    this.endpoints = {
      models: config.endpoints?.models ?? '/v1/models',
      pricing: config.endpoints?.pricing ?? '/api/pricing',
      usage: config.endpoints?.usage ?? '/v1/dashboard/billing/usage',
      usageQuery: config.endpoints?.usageQuery ?? {},
      subscription: config.endpoints?.subscription ?? '/v1/dashboard/billing/subscription',
    }
  }

  getKeyScopeFingerprint(): string {
    return createKeyScopeFingerprint({ supplier: SUPPLIER, apiBase: this.apiBase, apiKey: this.apiKey })
  }

  async fetchSnapshot(signal?: AbortSignal): Promise<SupplierRawSnapshot<NewApiRawEndpoints & Record<string, import('../types.js').SupplierEndpointResult<unknown>>>> {
    const fetchedAt = Date.now()
    const usageUrl = this.buildUsageUrl()

    const [models, pricing, billing, status] = await Promise.all([
      this.getJson<NewApiModelsPayload>(`${this.apiBase}${this.endpoints.models}`, signal),
      this.getJson<NewApiPricingPayload>(`${this.apiBase}${this.endpoints.pricing}`, signal),
      this.getJson<NewApiBillingPayload>(usageUrl, signal),
      this.getJson<NewApiStatusPayload>(`${this.apiBase}${this.endpoints.subscription}`, signal),
    ])

    return {
      supplier: SUPPLIER,
      fetchedAt,
      keyScopeFingerprint: this.getKeyScopeFingerprint(),
      endpoints: { models, pricing, billing, status },
    }
  }

  private buildUsageUrl(): string {
    const base = `${this.apiBase}${this.endpoints.usage}`
    const query = this.endpoints.usageQuery
    const entries = Object.entries(query)
    if (entries.length === 0) return base
    const qs = entries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
    return `${base}?${qs}`
  }

  private async getJson<T>(url: string, signal?: AbortSignal): Promise<import('../types.js').SupplierEndpointResult<T>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    try {
      const response = await this.fetchLike(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          ...this.extraHeaders,
        },
        signal: controller.signal,
      })

      const fetchedAt = Date.now()
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        return {
          url,
          status: response.status,
          fetchedAt,
          success: false,
          error: `HTTP ${response.status}: ${text.slice(0, 200)}`,
        }
      }

      const data = await response.json() as T
      return { url, status: response.status, fetchedAt, success: true, data }
    } catch (error) {
      return {
        url,
        status: 0,
        fetchedAt: Date.now(),
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
