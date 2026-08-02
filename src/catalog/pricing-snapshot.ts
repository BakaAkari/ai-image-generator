/**
 * 动态定价快照服务（new-api 系）。
 *
 * 目的：让「预扣上界」与「实际结算」都基于**实时** `/api/pricing` 数据，
 * 而不是 6 小时目录快照——渠道/分组倍率与模型资费会随时间调整，
 * 快照会滞后。本模块提供：
 *
 * - 60s 进程内缓存（TTL 可配），避免每次生成都打一次上游；
 * - getUpperBoundRatio(modelId)：该模型 enable_groups 中最大的 group_ratio，
 *   用作预扣上界（保证预扣 ≥ 任何实际路由成本 → 没钱就被拒）；
 * - resolveActualRatio(routingGroup)：响应头 x-routing-group 对应的倍率，
 *   用作结算（精确到本次实际路由的分组）。
 *
 * 失败回退策略（fail-safe）：
 * - pricing 拉取失败 → 返回 null，调用方回退到目录快照或 mapping 固定倍率；
 * - 分组不在表中 → 回退 group_ratio['default']，再退 1。
 */

import { createHash } from 'crypto'

export interface PricingSnapshotData {
  /** 分组名 → 分组倍率（/api/pricing 的 group_ratio） */
  groupRatio: Record<string, number>
  /** 模型名 → 该模型定价条目（model_price 为 per-call 单价，enable_groups 为开放分组） */
  models: Map<string, { modelPrice?: number; enableGroups?: string[]; quotaType?: number }>
  fetchedAt: number
}

export interface PricingSnapshotOptions {
  apiBase: string
  apiKey: string
  timeoutMs?: number
  ttlMs?: number
  extraHeaders?: Record<string, string>
  /** 覆盖 pricing 端点路径（默认 /api/pricing） */
  pricingPath?: string
}

/** 实时拉取 /api/pricing 并解析为 PricingSnapshotData。 */
export async function fetchPricingSnapshot(options: PricingSnapshotOptions): Promise<PricingSnapshotData | null> {
  const base = options.apiBase.trim().replace(/\/+$/, '')
  const path = options.pricingPath ?? '/api/pricing'
  const timeoutMs = options.timeoutMs ?? 8_000

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${base}${path}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
        ...(options.extraHeaders ?? {}),
      },
      signal: controller.signal,
    })
    if (!response.ok) return null

    const raw = await response.json() as {
      group_ratio?: Record<string, number | string>
      data?: Array<{
        model_name?: string
        model_price?: number
        quota_type?: number
        enable_groups?: string[]
      }>
    }

    const groupRatio: Record<string, number> = {}
    for (const [key, value] of Object.entries(raw.group_ratio ?? {})) {
      const num = typeof value === 'number' ? value : Number(value)
      if (Number.isFinite(num) && num >= 0) groupRatio[key] = num
    }

    const models = new Map<string, { modelPrice?: number; enableGroups?: string[]; quotaType?: number }>()
    for (const item of raw.data ?? []) {
      const name = item.model_name?.trim().toLowerCase()
      if (!name) continue
      models.set(name, {
        modelPrice: typeof item.model_price === 'number' ? item.model_price : undefined,
        enableGroups: Array.isArray(item.enable_groups) ? item.enable_groups : undefined,
        quotaType: typeof item.quota_type === 'number' ? item.quota_type : undefined,
      })
    }

    return { groupRatio, models, fetchedAt: Date.now() }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export class PricingSnapshotService {
  private snapshot: PricingSnapshotData | null = null
  private lastFetchAt = 0
  private readonly ttlMs: number
  private readonly options: PricingSnapshotOptions
  private readonly fingerprint: string

  constructor(options: PricingSnapshotOptions) {
    this.options = options
    this.ttlMs = options.ttlMs ?? 60_000
    this.fingerprint = this.buildFingerprint(options)
  }

  private buildFingerprint(options: PricingSnapshotOptions): string {
    const h = createHash('sha256')
    h.update(`${options.apiBase}:${options.apiKey.slice(0, 8)}:${options.pricingPath ?? '/api/pricing'}`)
    return h.digest('hex').slice(0, 12)
  }

  /** 当前缓存对应哪个凭证（供调用方判断快照是否过期/需重建）。 */
  get scopeFingerprint(): string {
    return this.fingerprint
  }

  private async ensureFresh(): Promise<PricingSnapshotData | null> {
    const now = Date.now()
    if (this.snapshot && now - this.lastFetchAt < this.ttlMs) return this.snapshot
    const fresh = await fetchPricingSnapshot(this.options)
    if (!fresh) {
      // 拉取失败：若已有旧快照则继续用（stale-while-error），否则 null
      if (this.snapshot) return this.snapshot
      return null
    }
    this.snapshot = fresh
    this.lastFetchAt = now
    return fresh
  }

  /** 当前快照（可能过期；不主动拉取）。 */
  get current(): PricingSnapshotData | null {
    return this.snapshot
  }

  /**
   * 模型 per-call 单价（美元/次，new-api model_price）。
   * 返回 null 表示模型无定价条目（调用方应回退目录快照）。
   */
  async getModelPrice(modelId: string): Promise<number | null> {
    const snap = await this.ensureFresh()
    const entry = snap?.models.get(modelId.trim().toLowerCase())
    if (!entry || typeof entry.modelPrice !== 'number') return null
    return entry.modelPrice
  }

  /**
   * 预扣上界倍率：该模型 enable_groups 中最大的 group_ratio。
   * 保证预扣 ≥ 实际路由成本（路由只从 enable_groups 中选）。
   * 无 enable_groups / 无定价条目时返回 null（调用方回退）。
   */
  async getUpperBoundRatio(modelId: string): Promise<number | null> {
    const snap = await this.ensureFresh()
    if (!snap) return null
    const entry = snap.models.get(modelId.trim().toLowerCase())
    const groups = entry?.enableGroups
    if (!groups || groups.length === 0) return null
    let max = -1
    for (const group of groups) {
      const ratio = snap.groupRatio[group]
      if (typeof ratio === 'number' && ratio >= 0 && ratio > max) max = ratio
    }
    return max >= 0 ? max : null
  }

  /**
   * 结算倍率：x-routing-group 响应头对应的 group_ratio。
   * 命中即精确；未命中回退 'default'，再退 1（保守按无倍率处理）。
   */
  async resolveActualRatio(routingGroup: string | null | undefined): Promise<number> {
    if (!routingGroup) return 1
    const snap = await this.ensureFresh()
    if (!snap) return 1
    const direct = snap.groupRatio[routingGroup]
    if (typeof direct === 'number' && direct >= 0) return direct
    const fallback = snap.groupRatio['default']
    if (typeof fallback === 'number' && fallback >= 0) return fallback
    return 1
  }
}
