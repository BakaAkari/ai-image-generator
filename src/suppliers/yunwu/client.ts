import { createHash } from 'crypto'
import type { SupplierCredentials, FetchLike, SupplierRawSnapshot, ImageSupplierAdapter } from '../types.js'
import type {
  YunwuBillingPayload,
  YunwuModelsPayload,
  YunwuPricingPayload,
  YunwuRawEndpoints,
  YunwuStatusPayload,
} from './raw-types.js'

export interface YunwuClientConfig extends SupplierCredentials {}

export interface KeyScopeMaterial {
  supplier: string
  apiBase: string
  apiKey: string
}

const SUPPLIER = 'yunwu'

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

export class YunwuClient implements ImageSupplierAdapter<SupplierRawSnapshot<YunwuRawEndpoints & Record<string, import('../types.js').SupplierEndpointResult<unknown>>>> {
  readonly id = SUPPLIER
  private readonly apiBase: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly fetchLike: FetchLike

  constructor(
    config: YunwuClientConfig,
    fetchLike: FetchLike = globalThis.fetch.bind(globalThis)
  ) {
    this.apiBase = normalizeApiBase(config.apiBase)
    this.apiKey = config.apiKey
    this.timeoutMs = (config.timeoutSec ?? 30) * 1000
    this.fetchLike = fetchLike
  }

  getKeyScopeFingerprint(): string {
    return createKeyScopeFingerprint({ supplier: SUPPLIER, apiBase: this.apiBase, apiKey: this.apiKey })
  }

  async fetchSnapshot(signal?: AbortSignal): Promise<SupplierRawSnapshot<YunwuRawEndpoints & Record<string, import('../types.js').SupplierEndpointResult<unknown>>>> {
    const fetchedAt = Date.now()
    const [models, pricing, billing, status] = await Promise.all([
      this.getJson<YunwuModelsPayload>(`${this.apiBase}/v1/models`, signal),
      this.getJson<YunwuPricingPayload>(`${this.apiBase}/api/pricing`, signal),
      this.getJson<YunwuBillingPayload>(`${this.apiBase}/v1/dashboard/billing/usage`, signal),
      this.getJson<YunwuStatusPayload>(`${this.apiBase}/v1/dashboard/billing/subscription`, signal),
    ])

    return {
      supplier: SUPPLIER,
      fetchedAt,
      keyScopeFingerprint: this.getKeyScopeFingerprint(),
      endpoints: { models, pricing, billing, status },
    }
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
