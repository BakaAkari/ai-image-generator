/**
 * new-api 系平台通用客户端（yunwu / gptgod 共用）
 *
 * 端点（均实测于 yunwu 2026-07-21）：
 *   GET {base}/v1/models          — 模型清单（key 分组过滤）
 *   GET {base}/api/pricing        — 定价表（model_price / model_ratio / quota_type / enable_groups）
 *   GET {base}/v1/dashboard/billing/usage        — 累计消耗（quota 分，500000 = $1）
 *   GET {base}/v1/dashboard/billing/subscription — key 限额
 */
import type { NewApiModelItem, NewApiPricingItem } from './types.js'

export interface NewApiClientOptions {
  apiBase: string
  apiKey: string
  timeoutSec: number
  extraHeaders?: Record<string, string>
}

export interface BillingInfo {
  /** 累计消耗（美元） */
  totalUsageUsd: number | null
  /** 软/硬限额（美元） */
  softLimitUsd?: number
  hardLimitUsd?: number
  tokenName?: string
}

export class NewApiClient {
  private base: string
  private key: string
  private timeoutSec: number
  private extraHeaders: Record<string, string>

  constructor(opts: NewApiClientOptions) {
    // 用户配置通常以 /v1 结尾；管理类接口在根路径
    this.base = opts.apiBase.replace(/\/+$/, '').replace(/\/v1$/, '')
    this.key = opts.apiKey
    this.timeoutSec = opts.timeoutSec
    this.extraHeaders = opts.extraHeaders ?? {}
  }

  private async fetchJson(url: string): Promise<any> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutSec * 1000)
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.key}`,
          Accept: 'application/json',
          ...this.extraHeaders,
        },
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  async fetchModels(): Promise<NewApiModelItem[]> {
    const data = await this.fetchJson(`${this.base}/v1/models`)
    return Array.isArray(data?.data) ? data.data : []
  }

  /** 定价表；平台不支持（404 等）时返回 null 由调用方降级 */
  async fetchPricing(): Promise<NewApiPricingItem[] | null> {
    try {
      const data = await this.fetchJson(`${this.base}/api/pricing`)
      return Array.isArray(data?.data) ? data.data : null
    } catch {
      return null
    }
  }

  async fetchBilling(): Promise<BillingInfo> {
    const [usage, subscription] = await Promise.allSettled([
      this.fetchJson(`${this.base}/v1/dashboard/billing/usage`),
      this.fetchJson(`${this.base}/v1/dashboard/billing/subscription`),
    ])
    const info: BillingInfo = { totalUsageUsd: null }
    if (usage.status === 'fulfilled' && typeof usage.value?.total_usage === 'number') {
      // new-api quota 单位：500000 = $1
      info.totalUsageUsd = usage.value.total_usage / 500000
    }
    if (subscription.status === 'fulfilled') {
      const s = subscription.value
      if (typeof s?.soft_limit_usd === 'number') info.softLimitUsd = s.soft_limit_usd
      if (typeof s?.hard_limit_usd === 'number') info.hardLimitUsd = s.hard_limit_usd
      if (typeof s?.token_name === 'string') info.tokenName = s.token_name
    }
    return info
  }
}

/** 图像模型识别：按 model_type 或已知图像模型命名模式 */
export function isImageModel(item: NewApiModelItem): boolean {
  if (item.model_type && /图像|图片|image/i.test(item.model_type)) return true
  const id = item.id.toLowerCase()
  return (
    id.includes('image') ||
    id.includes('dall-e') ||
    id.includes('flux') ||
    id.includes('seedream') ||
    id.includes('seededit') ||
    id.includes('kolors') ||
    id.includes('imagen') ||
    id.startsWith('mj_') ||
    id.startsWith('wan2.') && id.includes('image') ||
    id.includes('qwen-image') ||
    id.includes('grok') && id.includes('image') ||
    id.includes('sora_image')
  )
}

/** 从 supported_endpoint_types / 命名推断生成模式 */
export function inferModes(item: NewApiModelItem): Array<'text-to-image' | 'image-to-image'> {
  const endpoints = (item.supported_endpoint_types ?? []).join(' ')
  const text = `${endpoints} ${item.id} ${item.description ?? ''}`
  const modes: Array<'text-to-image' | 'image-to-image'> = []
  if (/文生图|文生|text-to-image|t2i|text2image|generations/i.test(text)) modes.push('text-to-image')
  if (/图生图|图生|image-to-image|i2i|image2image|edit|改图/i.test(text)) modes.push('image-to-image')
  if (modes.length === 0) {
    // 无法判断时默认两种都支持（OpenAI 系 images API 天然支持）
    modes.push('text-to-image', 'image-to-image')
  }
  return modes
}
