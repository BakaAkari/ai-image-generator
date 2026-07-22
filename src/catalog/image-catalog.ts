/**
 * 图像模型目录服务
 *
 * 职责：
 * - 按激活供应商拉取模型清单 + 定价，合并为 ImageModelInfo[]
 * - 内存缓存 + 文件持久化（data/<plugin>/model-catalog.json），重启不丢
 * - 定时刷新（默认 6h）+ 手动刷新；失败沿用旧缓存，永不阻塞生成
 */
import type { Context, Logger } from 'koishi'
import path from 'node:path'

import type { BillingInfo } from './billing-info.js'
import { normalizeYunwuBilling } from './billing-info.js'
import type { ActiveSupplier, CatalogSnapshot, ImageModelInfo } from './types.js'
import { createKeyScopeFingerprint, YunwuClient } from '../suppliers/yunwu/client.js'
import { normalizeYunwuSnapshot } from '../suppliers/yunwu/normalizer.js'
import type { YunwuRawSnapshot } from '../suppliers/yunwu/raw-types.js'
import { CatalogFileRepository } from './catalog-repository.js'
import { CatalogScheduler } from './catalog-scheduler.js'

export function canPublishYunwuSnapshot(snapshot: Pick<YunwuRawSnapshot, 'endpoints'>): boolean {
  return snapshot.endpoints.models.success === true
}

export class ImageCatalogService {
  private snapshot: CatalogSnapshot | null = null
  private billing: BillingInfo | null = null
  private readonly repository: CatalogFileRepository<{ snapshot: CatalogSnapshot; billing: BillingInfo | null }>
  private scheduler: CatalogScheduler | null = null
  private refreshing: Promise<CatalogSnapshot | null> | null = null
  private getConfig: (() => { supplier: ActiveSupplier; apiBase: string; apiKey: string; timeoutSec: number; refreshHours: number; extraHeaders?: Record<string, string> }) | null = null

  constructor(
    private ctx: Context,
    private logger: Logger,
    dataDir: string,
  ) {
    this.repository = new CatalogFileRepository(path.join(dataDir, 'model-catalog-v2.json'))
  }

  get current(): CatalogSnapshot | null {
    return this.snapshot
  }

  get billingInfo(): BillingInfo | null {
    return this.billing
  }

  /** 启动定时刷新；立即恢复当前 scope 缓存并触发后台刷新。 */
  start(getConfig: () => { supplier: ActiveSupplier; apiBase: string; apiKey: string; timeoutSec: number; refreshHours: number; extraHeaders?: Record<string, string> }) {
    this.getConfig = getConfig
    this.scheduler = new CatalogScheduler(async () => {
      const cfg = getConfig()
      if (!cfg.apiKey) return
      await this.refresh(cfg)
    })
    this.scheduler.start(Math.max(1, getConfig().refreshHours || 6))
    void this.restoreCurrentScope().then(() => this.scheduler?.refreshNow())
    this.ctx.on('dispose', () => this.stop())
  }

  updateRefreshHours(hours: number): void {
    this.scheduler?.updateInterval(Math.max(1, hours || 6))
  }

  stop(): void {
    this.scheduler?.stop()
    this.scheduler = null
  }

  /** 手动/定时刷新；并发调用合并为同一 Promise */
  refresh(cfg: { supplier: ActiveSupplier; apiBase: string; apiKey: string; timeoutSec: number; extraHeaders?: Record<string, string> }): Promise<CatalogSnapshot | null> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.doRefresh(cfg).finally(() => { this.refreshing = null })
    return this.refreshing
  }

  private async doRefresh(cfg: { supplier: ActiveSupplier; apiBase: string; apiKey: string; timeoutSec: number; extraHeaders?: Record<string, string> }): Promise<CatalogSnapshot | null> {
    if (cfg.supplier !== 'yunwu') {
      const message = `supplier ${cfg.supplier} is not adapted; only yunwu is maintained`
      this.logger.warn(message)
      if (this.snapshot) this.snapshot = { ...this.snapshot, error: message }
      return this.snapshot
    }
    const client = new YunwuClient({
      apiBase: cfg.apiBase,
      apiKey: cfg.apiKey,
      timeoutSec: cfg.timeoutSec,
      extraHeaders: cfg.extraHeaders,
    })
    try {
      const raw = await client.fetchSnapshot()
      if (!canPublishYunwuSnapshot(raw)) {
        const message = raw.endpoints.models.error || 'yunwu models endpoint failed'
        this.logger.warn('model catalog refresh rejected: %s（沿用旧缓存）', message)
        if (this.snapshot) this.snapshot = { ...this.snapshot, error: message }
        return this.snapshot
      }
      const normalized = normalizeYunwuSnapshot(raw)
      this.billing = normalizeYunwuBilling(raw)
      const models: ImageModelInfo[] = normalized.models.map(model => ({
        id: model.id,
        routes: model.routes
          .filter((route): route is typeof route & { protocol: 'openai' | 'gemini' } => route.protocol === 'openai' || route.protocol === 'gemini'),
        modes: [...new Set(model.capabilities.map(capability => capability === 'image-edit' ? 'image-to-image' : capability))]
          .filter((mode): mode is 'text-to-image' | 'image-to-image' => mode === 'text-to-image' || mode === 'image-to-image'),
        description: model.description?.slice(0, 200),
        pricing: model.pricing,
        source: model.pricing.source,
      }))
      const unsupportedModels = normalized.allModels
        .filter(model => !model.executable)
        .map(model => ({
          id: model.id,
          description: model.description?.slice(0, 200),
          unsupportedReasons: model.unsupportedReasons ?? ['no recognized image generation endpoint'],
        }))
      this.snapshot = {
        supplier: 'yunwu',
        models,
        unsupportedModels,
        fetchedAt: normalized.fetchedAt,
        error: normalized.error,
      }
      await this.persist(cfg)
      this.logger.info('model catalog refreshed: supplier=yunwu models=%d unsupported=%d billing=%s',
        models.length, unsupportedModels.length,
        this.billing.totalUsageUsd != null ? `$${this.billing.totalUsageUsd.toFixed(2)}` : 'n/a')
      return this.snapshot
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.logger.warn('model catalog refresh failed: %s（沿用旧缓存）', message)
      if (this.snapshot) this.snapshot = { ...this.snapshot, error: message }
      return this.snapshot
    }
  }

  private async persist(cfg: { supplier: ActiveSupplier; apiBase: string; apiKey: string }) {
    const keyScopeFingerprint = createKeyScopeFingerprint({ supplier: cfg.supplier, apiBase: cfg.apiBase, apiKey: cfg.apiKey })
    try {
      await this.repository.save({
        schemaVersion: 1,
        parserVersion: 'legacy-catalog-bridge-v1',
        keyScopeFingerprint,
        savedAt: Date.now(),
        catalog: { snapshot: this.snapshot!, billing: this.billing },
      })
    } catch (err) {
      this.logger.warn('model catalog persist failed: %s', err)
    }
  }

  private async restoreCurrentScope() {
    const cfg = this.getConfig?.()
    if (!cfg?.apiKey || !cfg.apiBase) return
    const keyScopeFingerprint = createKeyScopeFingerprint({ supplier: cfg.supplier, apiBase: cfg.apiBase, apiKey: cfg.apiKey })
    const loaded = await this.repository.load(keyScopeFingerprint)
    if (!loaded) return
    this.snapshot = {
      ...loaded.envelope.catalog.snapshot,
      unsupportedModels: loaded.envelope.catalog.snapshot.unsupportedModels ?? [],
    }
    this.billing = loaded.envelope.catalog.billing
    this.logger.info('model catalog restored from scoped cache: %d models stale=%s', this.snapshot.models.length, loaded.stale)
  }
}
