/**
 * 将 new-api 模型能力映射到生成路由。
 *
 * 设计（v2.3 语义规则引擎）：
 * - 端点名 → 协议/能力 的判定由「语义规则」驱动，不再穷举端点名硬编码。
 *   规则按语义分类（阻断 / 协议+能力），新端点名只要符合语义即自动识别
 *   （例如 `OpenAI image edit` / `images/edits` / `image edit 2` 都命中 edit 语义）。
 * - endpointAliases（用户显式配置）优先级最高，先于语义规则判定。
 * - 语义规则负责协议判定（openai / gemini / mj），能力判定通过规则携带的 capabilities 产出。
 * - 阻断规则负责 fail-closed：video / recognition / upload / template /
 *   未接入契约的 MJ 操作 / Kling 等端点不产出路由。
 */

import type { GenerationProtocol, GenerationRoute, ModelCapability } from '../../catalog/model-catalog.js'

export interface EndpointAliasMap {
  [endpointName: string]: { protocol: 'openai' | 'gemini' | 'mj'; capability: 'text-to-image' | 'image-to-image' | 'image-edit' }
}

export interface SemanticRule {
  /** 规则名（诊断 / 测试用） */
  name: string
  /** 语义匹配表达式（大小写不敏感，应用在 trim + toLowerCase 后的端点名上） */
  match: RegExp
  /** 命中后产出路由的协议；阻断规则省略 */
  protocol?: GenerationProtocol
  /** 命中后产出路由的能力；阻断规则省略 */
  capabilities?: ModelCapability[]
  /** 阻断规则：命中即不产出路由（fail-closed） */
  block?: boolean
  /** 诊断原因说明 */
  reason?: string
}

export interface RouteSpec {
  endpoint: string
  protocol: GenerationProtocol
  capability: ModelCapability
}

/** 阻断规则：语义上不属于「可执行图像生成」的端点，先于协议/能力规则判定。 */
const BLOCK_RULES: SemanticRule[] = [
  { name: 'avatar-video', match: /数字人|avatar|image2video|image-to-video|video/, block: true, reason: 'avatar/video endpoint' },
  { name: 'upload', match: /上传|upload/, block: true, reason: 'upload endpoint' },
  { name: 'template', match: /图片模板|image[ -]?template|template/, block: true, reason: 'image template endpoint' },
  { name: 'recognition', match: /识别|recognition|recognize/, block: true, reason: 'recognition-only endpoint' },
  { name: 'mj-unsupported', match: /^mj\s*(action|blend|describe|modal|upscale|variation|img2img|remix|pan|zoom)$|^mj动作$|^mj混合$|^mj描述模式$|^mj模态模式$|^mj图片上传$/, block: true, reason: 'unsupported MJ operation (no contract)' },
  { name: 'kling', match: /kling|omni-image/i, block: true, reason: 'Kling not wired into contract layer' },
]

/** 协议+能力规则：按语义产出路由。顺序即优先级（先精确后宽泛）。 */
const SEMANTIC_RULES: SemanticRule[] = [
  // Midjourney Imagine —— 唯一已实现契约（newapi.mj.imagine）。
  // 中英文端点名都覆盖：`mj想象模式` / `MJ imagine` / `mj imagine`。
  { name: 'mj-imagine', match: /^mj\s*想象模式$|^mj\s*imagine$/i, protocol: 'mj', capabilities: ['text-to-image'], reason: 'mj imagine endpoint' },
  // Gemini generateContent 同一 endpoint 同时承载文生图与参考图编辑。
  { name: 'gemini', match: /^gemini$/i, protocol: 'gemini', capabilities: ['text-to-image', 'image-to-image'], reason: 'gemini image endpoint' },
  // OpenAI 编辑语义（中英文）：edit / edits / 编辑 / 修图 等。
  { name: 'openai-edit', match: /edit|编辑|修图|ps/i, protocol: 'openai', capabilities: ['image-edit'], reason: 'openai edit endpoint' },
  // OpenAI 生成语义（中英文）：generation / generations / generate / dall-e / 绘图 等。
  { name: 'openai-gen', match: /generation|generations|generate|dall-?e|绘图|绘画/i, protocol: 'openai', capabilities: ['text-to-image'], reason: 'openai generation endpoint' },
  // 裸 openai 端点：默认按文生图处理（保守）。
  { name: 'openai-plain', match: /^openai$/i, protocol: 'openai', capabilities: ['text-to-image'], reason: 'openai image endpoint' },
]

/** 与 capability.ts 共享的 normalize：trim + toLowerCase。 */
export function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().toLowerCase()
}

/** 暴露给 capability.ts 判断「端点是否被识别为生成端点」使用。 */
export function matchSemanticRule(normalizedEndpoint: string): SemanticRule | undefined {
  return SEMANTIC_RULES.find((r) => r.match.test(normalizedEndpoint))
}

/** 判断端点是否命中阻断规则（fail-closed 前置）。 */
export function matchBlockRule(normalizedEndpoint: string): SemanticRule | undefined {
  return BLOCK_RULES.find((r) => r.match.test(normalizedEndpoint))
}

/** 判断端点是否被语义规则识别（阻断除外，仅用于诊断）。 */
export function isRecognizedEndpoint(normalizedEndpoint: string): boolean {
  return Boolean(matchSemanticRule(normalizedEndpoint)) || Boolean(matchBlockRule(normalizedEndpoint))
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

  for (const endpoint of endpoints) {
    const normalized = normalizeEndpoint(endpoint)
    if (!normalized) continue

    // 1. 用户显式别名（最高优先级）
    const alias = normalizedAliases?.get(normalized)
    if (alias) {
      const id = `${alias.protocol}:${alias.capability}`
      if (!seen.has(id)) {
        seen.add(id)
        routes.push({ id, protocol: alias.protocol, capability: alias.capability, endpointName: endpoint })
      }
      continue
    }

    // 2. 阻断规则（fail-closed）：命中不产出路由
    if (matchBlockRule(normalized)) continue

    // 3. 语义规则（协议 + 能力）
    const rule = matchSemanticRule(normalized)
    if (!rule?.protocol || !rule.capabilities) continue
    for (const capability of rule.capabilities) {
      const id = `${rule.protocol}:${capability}`
      if (!seen.has(id)) {
        seen.add(id)
        routes.push({ id, protocol: rule.protocol, capability, endpointName: endpoint })
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
