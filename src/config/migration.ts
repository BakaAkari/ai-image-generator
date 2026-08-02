import type { Config } from '../shared/config.js'
import type { ModelMappingConfig } from '../shared/types.js'

export interface MigrationResult {
  config: Config
  migrated: boolean
  actions: string[]
}

/**
 * 0.9.1 迁移目标：
 * - `costMarkup`（倍率）→ `pricingMarkupPercent`（百分比）
 * - 旧全局 provider 字段清理
 */
export function migrateConfig(config: Config): MigrationResult {
  const actions: string[] = []
  let changed = false
  const clone = structuredClone(config)
  const mappings = (clone.modelMappings ?? []) as ModelMappingConfig[]

  // activeSupplier: yunwu/gptgod → newapi（new-api 兼容站统一标识）
  const rawActive = clone.activeSupplier as string | undefined
  if (rawActive === 'yunwu' || rawActive === 'gptgod') {
    clone.activeSupplier = 'newapi'
    actions.push(`migrated activeSupplier ${rawActive} → newapi`)
    changed = true
  }

  for (const mapping of mappings) {
    if (mapping.supplier) { delete mapping.supplier; actions.push('removed legacy supplier from mapping'); changed = true }
    if (mapping.protocol) { delete mapping.protocol; actions.push('removed legacy protocol from mapping'); changed = true }
    if (mapping.provider) { delete mapping.provider; actions.push('removed legacy provider from mapping'); changed = true }
  }

  // costMarkup（倍率）→ pricingMarkupPercent（百分比）
  if (typeof clone.pricingMarkupPercent !== 'number' || !Number.isFinite(clone.pricingMarkupPercent)) {
    if (typeof clone.costMarkup === 'number' && Number.isFinite(clone.costMarkup) && clone.costMarkup > 0) {
      clone.pricingMarkupPercent = Math.max(0, Math.round((clone.costMarkup - 1) * 100 * 100) / 100)
      actions.push(`migrated costMarkup ${clone.costMarkup} → pricingMarkupPercent ${clone.pricingMarkupPercent}`)
      changed = true
    }
  }

  if ('costMarkup' in clone) { delete clone.costMarkup; actions.push('removed legacy costMarkup'); changed = true }
  if ('creditExchangeRate' in clone) { delete clone.creditExchangeRate; actions.push('removed legacy creditExchangeRate'); changed = true }

  if (mappings.length === 0) actions.push('modelMappings empty; explicit configuration required')
  if (clone.provider) { delete clone.provider; actions.push('removed legacy global provider field'); changed = true }

  // yunwuGroupRatio / yunwuGroup 迁移到 mapping.groupRatio
  let globalRatio: number | undefined
  if (typeof clone.yunwuGroupRatio === 'number' && Number.isFinite(clone.yunwuGroupRatio) && clone.yunwuGroupRatio > 0) {
    globalRatio = clone.yunwuGroupRatio
    actions.push(`read global yunwuGroupRatio=${globalRatio}`)
  } else if (typeof clone.yunwuGroup === 'string' && clone.yunwuGroup) {
    // yunwuGroup 字符串不在 migration 层有 catalog 信息，设为 1 等 catalog 解析时映射
    globalRatio = 1
    actions.push(`legacy yunwuGroup="${clone.yunwuGroup}" — will resolve via catalog at view-model time`)
  }
  if (globalRatio !== undefined) {
    for (const mapping of mappings) {
      if (mapping.groupRatio == null || typeof mapping.groupRatio !== 'number' || !Number.isFinite(mapping.groupRatio) || mapping.groupRatio <= 0) {
        (mapping as unknown as Record<string, unknown>).groupRatio = globalRatio
        actions.push(`set mapping ${mapping.suffix} groupRatio=${globalRatio} from global`)
      }
    }
  }
  // 清理旧字段（不报错，旧字段仍可存在于 JSON 中，interface 保留 @deprecated）
  if ('yunwuGroupRatio' in clone) { delete clone.yunwuGroupRatio; actions.push('removed legacy yunwuGroupRatio'); changed = true }
  if ('yunwuGroup' in clone) { delete clone.yunwuGroup; actions.push('removed legacy yunwuGroup'); changed = true }

  return { config: clone as Config, migrated: changed, actions }
}

export function sanitizeModelMapping(mapping: ModelMappingConfig): ModelMappingConfig {
  return {
    suffix: mapping.suffix,
    modelId: mapping.modelId,
    restricted: mapping.restricted,
    creditCostPerImage: mapping.creditCostPerImage,
  }
}
