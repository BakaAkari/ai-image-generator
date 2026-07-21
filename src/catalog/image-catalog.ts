/**
 * 图像模型目录服务
 *
 * 职责：
 * - 按激活供应商拉取模型清单 + 定价，合并为 ImageModelInfo[]
 * - 内存缓存 + 文件持久化（data/<plugin>/model-catalog.json），重启不丢
 * - 定时刷新（默认 6h）+ 手动刷新；失败沿用旧缓存，永不阻塞生成
 */
import type { Context, Logger } from 'koishi'
import fs from 'node:fs'
import path from 'node:path'

import { NewApiClient, inferModes, isImageModel, type BillingInfo } from './newapi-client.js'
import type { ActiveSupplier, CatalogSnapshot, ImageModelInfo, NewApiPricingItem } from './types.js'

const IMAGE_TYPE_PATTERN = /图像|图片|image/i

export class ImageCatalogService {
  private snapshot: CatalogSnapshot | null = null
  private billing: BillingInfo | null = null
  private timer: (() => void) | null = null
  private readonly persistPath: string
  private refreshing: Promise<CatalogSnapshot | null> | null = null

  constructor(
    private ctx: Context,
    private logger: Logger,
    dataDir: string,
  ) {
    this.persistPath = path.join(dataDir, 'model-catalog.json')
    this.loadPersisted()
  }

  get current(): CatalogSnapshot | null {
    return this.snapshot
  }

  get billingInfo(): BillingInfo | null {
    return this.billing
  }

  /** 启动定时刷新；立即触发一次后台刷新 */
  start(getConfig: () => { supplier: ActiveSupplier; apiBase: string; apiKey: string; timeoutSec: number; refreshHours: number; extraHeaders?: Record<string, string> }) {
    const tick = async () => {
      const cfg = getConfig()
      if (!cfg.apiKey) return
      await this.refresh(cfg)
    }
    void tick()
    const hours = Math.max(1, getConfig().refreshHours || 6)
    const dispose = this.ctx.setInterval(() => void tick(), hours * 3600_000)
    this.timer = dispose
    this.ctx.on('dispose', () => dispose())
  }

  /** 手动/定时刷新；并发调用合并为同一 Promise */
  refresh(cfg: { supplier: ActiveSupplier; apiBase: string; apiKey: string; timeoutSec: number; extraHeaders?: Record<string, string> }): Promise<CatalogSnapshot | null> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.doRefresh(cfg).finally(() => { this.refreshing = null })
    return this.refreshing
  }

  private async doRefresh(cfg: { supplier: ActiveSupplier; apiBase: string; apiKey: string; timeoutSec: number; extraHeaders?: Record<string, string> }): Promise<CatalogSnapshot | null> {
    const client = new NewApiClient({
      apiBase: cfg.apiBase,
      apiKey: cfg.apiKey,
      timeoutSec: cfg.timeoutSec,
      extraHeaders: cfg.extraHeaders,
    })
    try {
      const [rawModels, rawPricing, billing] = await Promise.all([
        client.fetchModels(),
        client.fetchPricing(),
        client.fetchBilling().catch(() => null),
      ])
      this.billing = billing

      const pricingMap = new Map<string, NewApiPricingItem>()
      for (const p of rawPricing ?? []) {
        const id = (p.model_name || p.model_id || p.id || '').toLowerCase()
        if (id) pricingMap.set(id, p)
      }

      const models: ImageModelInfo[] = []
      for (const m of rawModels) {
        if (!m?.id || !isImageModel(m)) continue
        const pricing = pricingMap.get(m.id.toLowerCase())
        models.push({
          id: m.id,
          modes: inferModes(m),
          description: m.description?.slice(0, 60),
          pricing: pricing ? {
            type: pricing.quota_type === 0 ? 'per-token' : pricing.quota_type === 1 ? 'per-call' : 'unknown',
            pricePerCall: pricing.quota_type === 1 && typeof pricing.model_price === 'number' ? pricing.model_price : undefined,
            tokenRatio: pricing.quota_type === 0 && typeof pricing.model_ratio === 'number' ? pricing.model_ratio : undefined,
            enableGroups: pricing.enable_groups,
          } : { type: 'unknown' },
          source: pricing ? 'remote-pricing' : 'remote-models',
        })
      }
      models.sort((a, b) => a.id.localeCompare(b.id))

      this.snapshot = {
        supplier: cfg.supplier,
        models,
        fetchedAt: Date.now(),
      }
      this.persist()
      this.logger.info('model catalog refreshed: supplier=%s models=%d pricing=%s billing=%s',
        cfg.supplier, models.length, rawPricing ? 'yes' : 'no',
        this.billing?.totalUsageUsd != null ? `$${this.billing.totalUsageUsd.toFixed(2)}` : 'n/a')
      return this.snapshot
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.logger.warn('model catalog refresh failed: %s（沿用旧缓存）', message)
      if (this.snapshot) {
        this.snapshot = { ...this.snapshot, error: message }
      }
      return this.snapshot
    }
  }

  private persist() {
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true })
      fs.writeFileSync(this.persistPath, JSON.stringify({ snapshot: this.snapshot, billing: this.billing }, null, 2))
    } catch (err) {
      this.logger.warn('model catalog persist failed: %s', err)
    }
  }

  private loadPersisted() {
    try {
      const raw = fs.readFileSync(this.persistPath, 'utf8')
      const data = JSON.parse(raw)
      if (data?.snapshot?.models?.length) this.snapshot = data.snapshot
      if (data?.billing) this.billing = data.billing
      if (this.snapshot) {
        this.logger.info('model catalog restored from disk: %d models', this.snapshot.models.length)
      }
    } catch { /* 首次启动无缓存，忽略 */ }
  }
}
