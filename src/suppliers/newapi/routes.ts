/**
 * 将 new-api 模型能力映射到生成路由。
 *
 * 路由由 endpoint 明确推导，不根据模型名猜测协议。
 */

import type { GenerationProtocol, GenerationRoute, ModelCapability } from '../../catalog/model-catalog.js'

export interface EndpointAliasMap {
  [endpointName: string]: { protocol: 'openai' | 'gemini' | 'mj'; capability: 'text-to-image' | 'image-to-image' | 'image-edit' }
}

export interface RouteSpec {
  endpoint: string
  protocol: GenerationProtocol
  capability: ModelCapability
}

const ENDPOINT_ROUTE_MAP: RouteSpec[] = [
  { endpoint: 'image-generation', protocol: 'openai', capability: 'text-to-image' },
  { endpoint: 'images/generations', protocol: 'openai', capability: 'text-to-image' },
  { endpoint: 'images-generations', protocol: 'openai', capability: 'text-to-image' },
  { endpoint: 'openai-绘图', protocol: 'openai', capability: 'text-to-image' },
  { endpoint: 'openai-编辑', protocol: 'openai', capability: 'image-edit' },
  { endpoint: 'openai编辑图片', protocol: 'openai', capability: 'image-edit' },
  // new-api 站点的英文端点名（gpt-image 系常用）：OpenAI image edit / images edits / edit
  { endpoint: 'openai image edit', protocol: 'openai', capability: 'image-edit' },
  { endpoint: 'images/edit', protocol: 'openai', capability: 'image-edit' },
  { endpoint: 'images/edits', protocol: 'openai', capability: 'image-edit' },
  { endpoint: 'images-edits', protocol: 'openai', capability: 'image-edit' },
  { endpoint: 'image-edits', protocol: 'openai', capability: 'image-edit' },
  { endpoint: 'edit', protocol: 'openai', capability: 'image-edit' },
  { endpoint: 'dall-e-3', protocol: 'openai', capability: 'text-to-image' },
  { endpoint: 'dall-e-2', protocol: 'openai', capability: 'text-to-image' },
  { endpoint: 'openai', protocol: 'openai', capability: 'text-to-image' },
  // Gemini generateContent 同一 endpoint 同时承载文生图与参考图编辑。
  // 显式产出两条 capability route，避免在运行时对整个 Gemini 协议做宽泛回退。
  { endpoint: 'gemini', protocol: 'gemini', capability: 'text-to-image' },
  { endpoint: 'gemini', protocol: 'gemini', capability: 'image-to-image' },
  // Midjourney Imagine —— 本轮唯一已实现契约（newapi.mj.imagine）
  { endpoint: 'mj想象模式', protocol: 'mj', capability: 'text-to-image' },
  // 其他 MJ Action/Blend/Describe/Kling/upload/图像识别 目前无契约支持，
  // fail-closed：在此不生成路由，模型会被 catalog 归入 unsupported。
]

export function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().toLowerCase()
}

export function resolveNewApiRoutes(endpoints: string[], aliases?: EndpointAliasMap): GenerationRoute[] {
  const routes: GenerationRoute[] = []
  const seen = new Set<string>()

  // Normalize alias keys once for case-insensitive lookup.
  const normalizedAliases = aliases
    ? new Map(
        Object.entries(aliases).map(([name, alias]) => [
          normalizeEndpoint(name),
          alias,
        ])
      )
    : null

  // Aliases take precedence over the default route table.
  if (normalizedAliases) {
    for (const endpoint of endpoints) {
      const normalized = normalizeEndpoint(endpoint)
      if (!normalized) continue

      const alias = normalizedAliases.get(normalized)
      if (!alias) continue

      const id = `${alias.protocol}:${alias.capability}`
      if (!seen.has(id)) {
        seen.add(id)
        routes.push({ id, protocol: alias.protocol, capability: alias.capability, endpointName: endpoint })
      }
    }
  }

  // Fallback to the built-in default route table.
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
