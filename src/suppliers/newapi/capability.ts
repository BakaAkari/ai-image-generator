/**
 * 从 new-api 模型元数据推导图像生成能力。
 *
 * 设计（v2.3 语义规则引擎）：
 * - 能力判定复用 routes.ts 的语义规则（matchSemanticRule / matchBlockRule），
 *   不再维护独立的端点集合，避免两套逻辑漂移。
 * - 阻断规则优先（video / recognition / upload / template / 非契约 MJ / Kling）；
 * - 语义规则命中产出对应能力（openai edit → image-edit，openai gen → text-to-image 等）；
 * - endpointAliases（用户显式配置）最高优先级：alias 声明的 capability 直接加入。
 * - 兜底：图像类型模型但端点全部未识别 → 保守产出 text-to-image（不误杀 dal-e 系空端点）。
 */

import type { ModelCapability } from '../../catalog/model-catalog.js'
import type { NewApiModelItem } from './raw-types.js'
import {
  matchBlockRule,
  matchSemanticRule,
  normalizeEndpoint,
  type EndpointAliasMap,
} from './routes.js'

export type { EndpointAliasMap } from './routes.js'

export interface CapabilityResult {
  capabilities: ModelCapability[]
  reasons: string[]
}

const NON_GENERATION_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /数字人|avatar|image2video|image-to-video|video/, reason: 'avatar/video endpoint' },
  { pattern: /上传|upload/, reason: 'upload endpoint' },
  { pattern: /图片模板|image.template|template/, reason: 'image template endpoint' },
  { pattern: /图像识别|image[- ]?recognition|recognize/, reason: 'recognition-only endpoint' },
  { pattern: /^mj动作$|^mj描述模式$|^mj模态模式$|^kling生图$|^kling多图生图$|^kling扩图$|^omni-image$/, reason: 'unsupported MJ/Kling operation (no contract)' },
]

function isImageModelType(modelType?: string): boolean {
  return !!modelType && /图像|图片|image/i.test(modelType)
}

function blockReasonsFromEndpoints(endpoints: string[]): string[] {
  const reasons: string[] = []
  for (const ep of endpoints) {
    for (const { pattern, reason } of NON_GENERATION_PATTERNS) {
      if (pattern.test(ep)) reasons.push(`${reason}: ${ep}`)
    }
  }
  return reasons
}

function blockReasonsFromModelType(item: NewApiModelItem): string[] {
  const reasons: string[] = []
  const type = (item.model_type ?? '').trim()
  if (type && !isImageModelType(type)) reasons.push(`model_type not image: ${type}`)
  return reasons
}

function mergeAliasEndpoints(endpoints: string[], aliases?: EndpointAliasMap): string[] {
  if (!aliases) return endpoints
  const aliasNames = Object.keys(aliases)
    .map((e) => e.trim())
    .filter(Boolean)
  return [...endpoints, ...aliasNames]
}

function capabilitiesFromEndpoints(endpoints: string[], aliases?: EndpointAliasMap): CapabilityResult {
  const caps = new Set<ModelCapability>()
  const reasons: string[] = []
  const normalized = endpoints.map(normalizeEndpoint).filter(Boolean)

  if (normalized.length === 0) {
    return { capabilities: [], reasons: [] }
  }

  // 1. 阻断规则（fail-closed）：命中即不产出任何能力
  for (const ep of normalized) {
    const block = matchBlockRule(ep)
    if (block) {
      reasons.push(`${block.reason}: ${ep}`)
    }
  }
  if (reasons.length > 0) {
    return { capabilities: [], reasons }
  }

  // 2. 用户显式别名：alias 声明的 capability 直接加入
  if (aliases) {
    for (const [name, alias] of Object.entries(aliases)) {
      const key = normalizeEndpoint(name)
      if (!key) continue
      if (normalized.includes(key)) {
        caps.add(alias.capability)
        reasons.push(`alias ${name} → ${alias.capability}`)
      }
    }
  }

  // 3. 语义规则：命中产出对应能力
  for (const ep of normalized) {
    const rule = matchSemanticRule(ep)
    if (!rule?.capabilities) continue
    for (const capability of rule.capabilities) {
      caps.add(capability)
    }
    if (rule.reason) reasons.push(rule.reason)
  }

  // 4. 兜底：图像类型模型但端点全部未识别 → 保守产出 text-to-image
  //    （避免 dall-e 系空端点 / 未知命名被误杀成不可用）
  if (caps.size === 0) {
    caps.add('text-to-image')
    reasons.push('openai image endpoint fallback')
  }

  return { capabilities: [...caps], reasons }
}

export function resolveNewApiCapabilities(item: NewApiModelItem, aliases?: EndpointAliasMap): CapabilityResult {
  const typeBlocks = blockReasonsFromModelType(item)
  const endpointBlocks = blockReasonsFromEndpoints(item.supported_endpoint_types ?? [])
  const allBlocks = [...typeBlocks, ...endpointBlocks]

  if (allBlocks.length > 0) {
    return { capabilities: [], reasons: allBlocks }
  }

  const mergedEndpoints = mergeAliasEndpoints(item.supported_endpoint_types ?? [], aliases)
  const { capabilities, reasons } = capabilitiesFromEndpoints(mergedEndpoints, aliases)
  if (capabilities.length === 0) {
    return { capabilities: [], reasons: ['no recognized image generation endpoint'] }
  }

  return { capabilities: [...new Set(capabilities)], reasons }
}

/**
 * 判断模型是否为「可执行的图像生成模型」。
 * - 阻断模型类型（音视频/非图像）→ false
 * - 阻断端点（video/recognition/upload/template/非契约 MJ/Kling）→ false
 * - 空端点且模型类型为图像 → 保守视为可执行（dall-e 系空端点场景）
 */
export function isNewApiExecutableImageModel(item: NewApiModelItem): boolean {
  const typeBlocks = blockReasonsFromModelType(item)
  if (typeBlocks.length > 0) return false

  const endpointBlocks = blockReasonsFromEndpoints(item.supported_endpoint_types ?? [])
  if (endpointBlocks.length > 0) return false

  const endpoints = item.supported_endpoint_types ?? []
  const normalized = endpoints.map(normalizeEndpoint).filter(Boolean)
  if (normalized.length === 0) return isImageModelType(item.model_type)

  return normalized.some((ep) => Boolean(matchSemanticRule(ep)))
}
