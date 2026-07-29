import type { ModelMappingConfig, ProviderType } from '../shared/types.js'
import type { ContractOperation } from '../contracts/types.js'

/**
 * 简化的 catalog 视图，只暴露路由查询需要的字段。
 */
export interface CatalogRouteView {
  id: string
  protocol: string
  capability: string
}

export interface CatalogModelForRouting {
  id: string
  routes: CatalogRouteView[]
}

export interface CatalogRouteSelection {
  routeId: string
  protocol: ProviderType
  /** 该路由对应的具体操作（text-to-image / image-edit / …）。 */
  operation: ContractOperation
}

/**
 * 目录路由查询：按 operation 精确匹配 route。
 *
 * - operation 缺省时按 text-to-image 匹配。
 * - 若模型没有对应 operation 的 route，返回 undefined（fail-closed）。
 */
export type CatalogRouteLookup = (
  modelId: string,
  operation?: ContractOperation,
) => CatalogRouteSelection | undefined

export class MissingModelMappingError extends Error {
  constructor() {
    super('未配置可用模型映射，请先在 aka-tools 中选择模型和收费策略')
    this.name = 'MissingModelMappingError'
  }
}

export class MissingCatalogRouteError extends Error {
  constructor(public readonly modelId: string, public readonly operation?: ContractOperation) {
    super(`模型 ${modelId}${operation ? ` 在 ${operation} 操作下` : ''} 没有可执行的目录路由`)
    this.name = 'MissingCatalogRouteError'
  }
}

export function resolveConfiguredModelRoute(
  mappings: ModelMappingConfig[],
  lookup: CatalogRouteLookup | undefined,
  operation: ContractOperation = 'text-to-image',
): CatalogRouteSelection & { mapping: ModelMappingConfig } {
  const mapping = mappings[0]
  if (!mapping?.modelId) throw new MissingModelMappingError()
  const route = lookup?.(mapping.modelId, operation)
  if (!route) throw new MissingCatalogRouteError(mapping.modelId, operation)
  return { ...route, mapping }
}

/**
 * 根据 catalog 中某个模型的路由集合，按目标 operation 选一条最合适的路由。
 *
 * fail-closed 约束：
 * - text-to-image 只匹配 capability=text-to-image 路由；
 * - image-edit / image-to-image / compose-image 首选 capability=image-edit / image-to-image 路由；
 * - 找不到时**仅** MJ 协议允许回退到 text-to-image（Imagine 通过 base64Array 表达图生图，
 *   走同一 endpoint）。OpenAI / Gemini 等协议如果没有 image-edit 路由必须返回 undefined，
 *   避免把编辑请求错误地打到 text-to-image endpoint。
 * - 未识别的协议（非 openai/gemini/mj）→ undefined。
 */
export function selectRouteForOperation(
  model: CatalogModelForRouting | undefined,
  operation: ContractOperation = 'text-to-image',
): CatalogRouteSelection | undefined {
  if (!model) return undefined
  const wantEdit = operation === 'image-edit' || operation === 'image-to-image' || operation === 'compose-image'
  const editCapabilities = ['image-edit', 'image-to-image']

  const editRoute = wantEdit
    ? model.routes.find((r) => editCapabilities.includes(r.capability))
    : undefined
  const textRoute = model.routes.find((r) => r.capability === 'text-to-image')

  let route: CatalogRouteView | undefined
  if (wantEdit) {
    if (editRoute) {
      route = editRoute
    } else if (textRoute && textRoute.protocol === 'mj') {
      // MJ Imagine 使用 base64Array 表达图生图；同 endpoint 复用 OK
      route = textRoute
    } else {
      return undefined
    }
  } else {
    route = textRoute
  }

  if (!route) return undefined
  if (route.protocol !== 'openai' && route.protocol !== 'gemini' && route.protocol !== 'mj') return undefined
  return { routeId: route.id, protocol: route.protocol as ProviderType, operation }
}
