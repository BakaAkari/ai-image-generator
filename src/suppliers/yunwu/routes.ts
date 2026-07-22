/**
 * 将 yunwu 模型能力映射到生成路由。
 *
 * 路由由 endpoint 明确推导，不根据模型名猜测协议。
 */

import type { GenerationProtocol, GenerationRoute, ModelCapability } from '../../catalog/model-catalog.js'

export interface RouteSpec {
  endpoint: string
  protocol: GenerationProtocol
  capability: ModelCapability
}

const ENDPOINT_ROUTE_MAP: RouteSpec[] = [
  { endpoint: 'image-generation', protocol: 'openai', capability: 'text-to-image' },
  { endpoint: 'images/generations', protocol: 'openai', capability: 'text-to-image' },
  { endpoint: 'openai-绘图', protocol: 'openai', capability: 'text-to-image' },
  { endpoint: 'openai-编辑', protocol: 'openai', capability: 'image-edit' },
  { endpoint: 'openai编辑图片', protocol: 'openai', capability: 'image-edit' },
  { endpoint: 'dall-e-3', protocol: 'openai', capability: 'text-to-image' },
  { endpoint: 'dall-e-2', protocol: 'openai', capability: 'text-to-image' },
  { endpoint: 'openai', protocol: 'openai', capability: 'text-to-image' },
  { endpoint: 'gemini', protocol: 'gemini', capability: 'text-to-image' },
]

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().toLowerCase()
}

export function resolveYunwuRoutes(endpoints: string[]): GenerationRoute[] {
  const routes: GenerationRoute[] = []
  const seen = new Set<string>()

  for (const endpoint of endpoints) {
    const normalized = normalizeEndpoint(endpoint)
    if (!normalized) continue

    for (const spec of ENDPOINT_ROUTE_MAP) {
      if (normalized === spec.endpoint) {
        const id = `${spec.protocol}:${spec.capability}`
        if (!seen.has(id)) {
          seen.add(id)
          routes.push({ id, protocol: spec.protocol, capability: spec.capability, endpointName: endpoint })
        }
      }
    }
  }

  return routes
}

/**
 * 根据模型能力补充路由：若 endpoint 未给出但能力明确，仍生成路由。
 * 这仅用于已知 endpoint 缺失但有明确生成能力的模型（如 dall-e-3 空 endpoint）。
 */
export function resolveRoutesFromCapabilities(capabilities: ModelCapability[]): GenerationRoute[] {
  const routes: GenerationRoute[] = []
  const seen = new Set<string>()

  const capabilityRouteMap: Partial<Record<ModelCapability, GenerationProtocol>> = {
    'text-to-image': 'openai',
    'image-to-image': 'openai',
    'image-edit': 'openai',
    'image-variation': 'openai',
    'image-upscale': 'openai',
  }

  for (const capability of capabilities) {
    const protocol = capabilityRouteMap[capability]
    const id = `${protocol}:${capability}`
    if (protocol && !seen.has(id)) {
      seen.add(id)
      routes.push({ id, protocol, capability })
    }
  }

  return routes
}
