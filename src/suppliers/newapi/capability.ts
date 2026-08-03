/**
 * 从 new-api 模型元数据推导图像生成能力。
 */

import type { ModelCapability } from '../../catalog/model-catalog.js'
import type { NewApiModelItem } from './raw-types.js'

export interface CapabilityResult {
  capabilities: ModelCapability[]
  reasons: string[]
}

export interface EndpointAliasMap {
  [endpointName: string]: { protocol: 'openai' | 'gemini' | 'mj'; capability: 'text-to-image' | 'image-to-image' | 'image-edit' }
}

const OPENAI_IMAGE_ENDPOINTS = new Set([
  'image-generation',
  'images/generations',
  'openai-绘图',
  'openai编辑图片',
  'openai-编辑',
  'openai image edit',
  'images/edit',
  'images/edits',
  'images-edits',
  'image-edits',
  'edit',
  'dall-e-3',
  'dall-e-2',
  'openai',
])

const GEMINI_IMAGE_ENDPOINTS = new Set(['gemini'])

/**
 * 已实现契约的 MJ/Kling endpoint —— 目前仅 MJ Imagine（newapi.mj.imagine 契约）。
 * 其他 MJ Action/Blend/Describe/Kling 未接入契约层，本轮显式 fail-closed。
 */
const MJ_KLING_IMAGE_ENDPOINTS = new Set([
  'mj想象模式',
])

/** 已识别但尚未接入契约的 MJ/Kling endpoint —— 显式记录理由，避免被误判成默认 openai。 */
const UNSUPPORTED_MJ_KLING_ENDPOINTS = new Set([
  'mj动作',
  'mj混合',
  'mj描述模式',
  'mj模态模式',
  'mj图片上传',
  'kling生图',
  'kling多图生图',
  'kling扩图',
  'omni-image',
])

const NON_GENERATION_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /数字人|avatar|image2video|image-to-video|video/, reason: 'avatar/video endpoint' },
  { pattern: /上传|upload/, reason: 'upload endpoint' },
  { pattern: /图片模板|image.template|template/, reason: 'image template endpoint' },
  { pattern: /图像识别|image[- ]?recognition|recognize/, reason: 'recognition-only endpoint' },
  { pattern: /^mj动作$|^mj混合$|^mj描述模式$|^mj模态模式$|^kling生图$|^kling多图生图$|^kling扩图$|^omni-image$/, reason: 'unsupported MJ/Kling operation (no contract)' },
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
    .map(e => e.trim())
    .filter(Boolean)
  return [...endpoints, ...aliasNames]
}

/** 与 routes.ts 的 normalizeEndpoint 保持一致：trim + toLowerCase。 */
function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().toLowerCase()
}

function capabilitiesFromEndpoints(endpoints: string[], aliases?: EndpointAliasMap): CapabilityResult {
  const caps = new Set<ModelCapability>()
  const reasons: string[] = []
  const normalized = endpoints.map(normalizeEndpoint).filter(Boolean)

  if (normalized.length === 0) {
    return { capabilities: [], reasons: [] }
  }

  // Treat aliased endpoint names as known endpoints of the aliased protocol.
  const effectiveOpenai = new Set(OPENAI_IMAGE_ENDPOINTS)
  const effectiveGemini = new Set(GEMINI_IMAGE_ENDPOINTS)
  const effectiveMjKling = new Set(MJ_KLING_IMAGE_ENDPOINTS)

  if (aliases) {
    for (const [name, alias] of Object.entries(aliases)) {
      const key = name.trim().toLowerCase()
      if (!key) continue
      if (alias.protocol === 'openai') effectiveOpenai.add(key)
      else if (alias.protocol === 'gemini') effectiveGemini.add(key)
      else if (alias.protocol === 'mj') effectiveMjKling.add(key)
    }
  }

  const hasOpenai = normalized.some(e => effectiveOpenai.has(e))
  const hasGemini = normalized.some(e => effectiveGemini.has(e))
  const hasMjKling = normalized.some(e => effectiveMjKling.has(e))
  const hasEdit = normalized.some(e => /编辑|edit/i.test(e)) || normalized.some(e => ['mj动作', 'kling扩图'].includes(e))
  const hasGeneration = normalized.some(e => /绘图|generation|generations|dall-e/i.test(e))
  const hasRecognition = normalized.some(e => ['mj描述模式', '图像识别'].includes(e))

  if (hasOpenai) {
    if (hasEdit) {
      caps.add('image-edit')
      reasons.push('openai-edit endpoint')
    }
    if (hasGeneration || hasEdit) {
      caps.add('text-to-image')
      caps.add('image-to-image')
      if (hasGeneration) reasons.push('openai-generation endpoint')
    }
    if (caps.size === 0) {
      caps.add('text-to-image')
      reasons.push('openai image endpoint')
    }
  }

  if (hasGemini) {
    caps.add('text-to-image')
    caps.add('image-to-image')
    reasons.push('gemini image endpoint')
  }

  if (hasMjKling) {
    caps.add('text-to-image')
    if (hasEdit) caps.add('image-edit')
    if (hasRecognition) caps.add('image-recognition')
    reasons.push('mj/kling endpoint')
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

export function isNewApiExecutableImageModel(item: NewApiModelItem, aliases?: EndpointAliasMap): boolean {
  const { capabilities } = resolveNewApiCapabilities(item, aliases)
  if (capabilities.length === 0) return false
  return isImageModelType(item.model_type)
}
