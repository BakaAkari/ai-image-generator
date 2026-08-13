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
import type { Config } from '../shared/config.js'
import type { AiImageGeneratorService } from '../service/AiImageGeneratorService.js'
import { buildConsoleState } from './view-model.js'
import { buildOverviewStats } from './overview-stats.js'
import { deriveConfigFromSnapshot, mergeDerivedMappings } from '../services/config-autopilot.js'
import { resolveEffectiveMode } from '../shared/effective-mode.js'

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
    // 定价模式运行时判定（fallback simple：无凭据 / 目录失败）
    const effective = resolveEffectiveMode(
      getConfig(),
      snapshot != null && !snapshot.error && snapshot.models.length > 0,
    )
    return { ...state, knownPlatforms, effectiveMode: effective }
  }, { authority: 4 })

  consoleService.addListener('image-generator/save-config', async (config: Config, ...rest: unknown[]) => {
    try {
      const prev = getConfig()
      const next = mergeConfig(prev, config)
      // 自动模式：保存时对 modelMappings 执行「只补缺」推导合并（单真源落盘）。
      // 一致性约束：已有映射（含 billingPolicy / tokenRatio / ratioOverride 等）永不被覆盖；
      // 推导只追加缺失 modelId；推导失败时保留当前映射不阻断。
      if (next.configMode === 'auto') {
        const snapshot = catalog?.current
        if (snapshot && snapshot.models.length > 0) {
          const existing = next.modelMappings ?? []
          const { suggestedMappings } = deriveConfigFromSnapshot(snapshot, existing)
          const merged = mergeDerivedMappings(existing, suggestedMappings)
          if (merged.length !== existing.length) {
            next.modelMappings = merged
            logger.info(
              'config-autopilot: auto mode derived %d missing mappings (existing %d → %d)',
              suggestedMappings.length,
              existing.length,
              merged.length,
            )
          }
        } else {
          logger.warn('config-autopilot: catalog snapshot unavailable, skip derivation (keep current mappings)')
        }
      }
      // 汇率/除数/估算变更审计：这三项直接影响结算金额，必须留痕以便事后追溯
      const AUDIT_FIELDS: Array<keyof Config> = ['usdToRmb', 'quotaPerUnit', 'perTokenEstimateTokens']
      for (const field of AUDIT_FIELDS) {
        const before = prev[field]
        const after = next[field]
        if (before !== after) {
          const requester = (rest?.[0] as { session?: { userId?: string; platform?: string } } | undefined)?.session
          logger.info(
            'config-audit field=%s before=%s after=%s requester=%s@%s',
            field,
            String(before ?? '(unset)'),
            String(after ?? '(unset)'),
            requester?.userId ?? 'console',
            requester?.platform ?? '-',
          )
        }
      }
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
