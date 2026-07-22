import type { Config } from '../shared/config.js'
import type { ModelMappingConfig } from '../shared/types.js'

export interface MigrationResult {
  config: Config
  migrated: boolean
  actions: string[]
}

export function migrateConfig(config: Config): MigrationResult {
  const actions: string[] = []
  const clone = structuredClone ? structuredClone(config) : JSON.parse(JSON.stringify(config))

  // 1. 移除模型映射中的已废弃 supplier / protocol / provider 字段
  const mappings = (clone.modelMappings ?? []) as ModelMappingConfig[]
  for (const m of mappings) {
    if (m.supplier) {
      delete m.supplier
      actions.push('removed legacy supplier from mapping')
    }
    if (m.protocol) {
      delete m.protocol
      actions.push('removed legacy protocol from mapping')
    }
    if (m.provider) {
      delete m.provider
      actions.push('removed legacy provider from mapping')
    }
  }

  // 2. 不再使用硬编码的缺省模型映射；保留用户已有映射
  // 如果完全空白，等待运行时从 catalog 动态渲染
  // 但 schema 中的默认值必须清除，这里仅记录
  if (mappings.length === 0) {
    actions.push('modelMappings empty; default models will be derived from catalog at runtime')
  }

  // 3. 移除已废弃的全局 provider 字段
  if (clone.provider) {
    delete clone.provider
    actions.push('removed legacy global provider field')
  }

  return { config: clone as Config, migrated: actions.length > 0, actions }
}

export function sanitizeModelMapping(mapping: ModelMappingConfig): ModelMappingConfig {
  const clean: ModelMappingConfig = {
    suffix: mapping.suffix,
    modelId: mapping.modelId,
    restricted: mapping.restricted,
    creditCostPerImage: mapping.creditCostPerImage,
  }
  return clean
}
