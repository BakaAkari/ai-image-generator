import type { Config } from '../shared/config.js'
import type { ModelMappingConfig } from '../shared/types.js'

export type CatalogQuoteAvailability = 'catalog-quote' | 'unknown'
export type CatalogQuoteLookup = (modelId: string) => CatalogQuoteAvailability

export interface MigrationResult {
  config: Config
  migrated: boolean
  actions: string[]
}

export function migrateConfig(config: Config, quoteLookup: CatalogQuoteLookup = () => 'unknown'): MigrationResult {
  const actions: string[] = []
  const clone = structuredClone(config)
  const mappings = (clone.modelMappings ?? []) as ModelMappingConfig[]

  for (const mapping of mappings) {
    if (mapping.supplier) { delete mapping.supplier; actions.push('removed legacy supplier from mapping') }
    if (mapping.protocol) { delete mapping.protocol; actions.push('removed legacy protocol from mapping') }
    if (mapping.provider) { delete mapping.provider; actions.push('removed legacy provider from mapping') }

    if (!mapping.chargePolicy) {
      if (typeof mapping.creditCostPerImage === 'number' && Number.isFinite(mapping.creditCostPerImage)) {
        mapping.chargePolicy = { type: 'fixed', creditsPerImage: mapping.creditCostPerImage }
        actions.push(`migrated fixed charge policy for ${mapping.modelId}`)
      } else if (quoteLookup(mapping.modelId) === 'catalog-quote') {
        mapping.chargePolicy = { type: 'cost-plus', acceptEstimated: false }
        actions.push(`migrated cost-plus charge policy for ${mapping.modelId}`)
      } else {
        mapping.chargePolicy = { type: 'disabled', reason: 'pricing unavailable' }
        actions.push(`disabled mapping without pricing for ${mapping.modelId}`)
      }
    }
  }

  if (mappings.length === 0) actions.push('modelMappings empty; explicit configuration required')
  if (clone.provider) { delete clone.provider; actions.push('removed legacy global provider field') }

  return { config: clone, migrated: actions.length > 0, actions }
}

export function sanitizeModelMapping(mapping: ModelMappingConfig): ModelMappingConfig {
  return {
    suffix: mapping.suffix,
    modelId: mapping.modelId,
    restricted: mapping.restricted,
    chargePolicy: mapping.chargePolicy,
    creditCostPerImage: mapping.creditCostPerImage,
  }
}
