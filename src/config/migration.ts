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

  return { config: clone, migrated: changed, actions }
}

export function sanitizeModelMapping(mapping: ModelMappingConfig): ModelMappingConfig {
  return {
    suffix: mapping.suffix,
    modelId: mapping.modelId,
    restricted: mapping.restricted,
    creditCostPerImage: mapping.creditCostPerImage,
  }
}
