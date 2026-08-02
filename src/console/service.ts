/**
 * aka-tools 面板后端 —— console 数据服务
 *
 * 通过 ctx.console.addListener 暴露：
 *   image-generator/get-state           面板全量状态（配置 + 目录 + billing）
 *   image-generator/save-config         保存配置（JSON 持久化 + 原地更新运行态）
 *   image-generator/refresh-catalog     手动刷新模型目录
 *   image-generator/get-model-ranking   模型用量排行（旧总览折叠卡，保留兼容）
 *   image-generator/get-overview-stats  总览页用量统计（全局合计 + 模型分布 + 用户排行）
 */
import type { Context, Logger } from 'koishi'

import type { ImageCatalogService } from '../catalog/image-catalog.js'
import type { BillingInfo } from '../catalog/billing-info.js'
import type { Config } from '../shared/config.js'
import type { AiImageGeneratorService } from '../service/AiImageGeneratorService.js'
import { buildConsoleState } from './view-model.js'
import { buildOverviewStats } from './overview-stats.js'

type CatalogCredentials = {
  supplier: string
  apiBase: string
  apiKey: string
  timeoutSec: number
  refreshHours: number
  extraHeaders?: Record<string, string>
} | null

export interface ConsoleServiceDeps {
  ctx: Context
  logger: Logger
  catalog: ImageCatalogService
  getConfig: () => Config
  refreshCatalog: () => Promise<unknown>
  writeConfig: (config: Config) => Promise<void>
  applyConfig: (config: Config) => Promise<void> | void
  mergeConfig: (current: Config, incoming: Partial<Config>) => Config
  service?: AiImageGeneratorService
  resolveCredentials?: (config: Config) => CatalogCredentials
  knownPlatforms?: Set<string>
}

export function registerConsoleService(deps: ConsoleServiceDeps) {
  const { ctx, logger, catalog, getConfig, refreshCatalog, writeConfig, applyConfig, mergeConfig } = deps
  const consoleService = (ctx as any).console as { addListener: (name: string, cb: (...args: any[]) => any, options?: any) => void }

  consoleService.addListener('image-generator/get-state', async () => {
    const snapshot = catalog.current
    const billing = catalog.billingInfo
    const state = buildConsoleState(getConfig(), snapshot ? {
      supplier: snapshot.supplier,
      fetchedAt: snapshot.fetchedAt,
      error: snapshot.error,
      models: snapshot.models,
      unsupportedModels: snapshot.unsupportedModels,
    } : null, billing)
    // 自动收集已知平台 ID（从运行时的 session.platform 获取）
    const knownPlatforms = Array.from(deps.knownPlatforms ?? new Set<string>())
    return { ...state, knownPlatforms }
  })

  consoleService.addListener('image-generator/save-config', async (config: Config) => {
    try {
      const next = mergeConfig(getConfig(), config)
      await writeConfig(next)
      await applyConfig(next)
      return { success: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('aka-tools save-config failed: %s', message)
      return { success: false, error: message }
    }
  }, { authority: 4 })

  consoleService.addListener('image-generator/get-model-ranking', async () => {
    const service = deps.service
    if (!service) return { totalRequests: 0, totalImages: 0, modelCounts: {}, topModel: null }
    return await service.getModelUsageStats()
  })

  consoleService.addListener('image-generator/get-overview-stats', async () => {
    const service = deps.service
    if (!service) return buildOverviewStats([])
    return await service.getOverviewStats()
  })

  consoleService.addListener('image-generator/refresh-catalog', async () => {
    await refreshCatalog()
    const snapshot = catalog.current
    return {
      success: !snapshot?.error,
      error: snapshot?.error,
      modelCount: snapshot?.models.length ?? 0,
    }
  }, { authority: 4 })
}
