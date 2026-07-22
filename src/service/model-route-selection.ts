import type { ModelMappingConfig, ProviderType } from '../shared/types.js'

export interface CatalogRouteSelection {
  routeId: string
  protocol: ProviderType
}

export type CatalogRouteLookup = (modelId: string) => CatalogRouteSelection | undefined

export class MissingModelMappingError extends Error {
  constructor() {
    super('未配置可用模型映射，请先在 aka-tools 中选择模型和收费策略')
    this.name = 'MissingModelMappingError'
  }
}

export class MissingCatalogRouteError extends Error {
  constructor(public readonly modelId: string) {
    super(`模型 ${modelId} 没有可执行的目录路由`)
    this.name = 'MissingCatalogRouteError'
  }
}

export function resolveConfiguredModelRoute(
  mappings: ModelMappingConfig[],
  lookup: CatalogRouteLookup | undefined,
): CatalogRouteSelection & { mapping: ModelMappingConfig } {
  const mapping = mappings[0]
  if (!mapping?.modelId) throw new MissingModelMappingError()
  const route = lookup?.(mapping.modelId)
  if (!route) throw new MissingCatalogRouteError(mapping.modelId)
  return { ...route, mapping }
}
