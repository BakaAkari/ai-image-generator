/**
 * 从 yunwu 模型元数据推导图像生成能力。
 */

import type { ModelCapability } from '../../catalog/model-catalog.js'
import type { YunwuModelItem } from './raw-types.js'

export interface CapabilityResult {
  capabilities: ModelCapability[]
  reasons: string[]
}

const OPENAI_IMAGE_ENDPOINTS = new Set([
  'image-generation',
  'images/generations',
  'openai-绘图',
  'openai编辑图片',
  'openai-编辑',
  'dall-e-3',
  'dall-e-2',
  'openai',
])

const GEMINI_IMAGE_ENDPOINTS = new Set(['gemini'])

const NON_GENERATION_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /数字人|avatar|image2video|image-to-video|video/, reason: 'avatar/video endpoint' },
  { pattern: /图像识别|识别|recognition|recognize|vision/, reason: 'image recognition endpoint' },
  { pattern: /上传|upload/, reason: 'upload endpoint' },
  { pattern: /图片模板|image.template|template/, reason: 'image template endpoint' },
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

function blockReasonsFromModelType(item: YunwuModelItem): string[] {
  const reasons: string[] = []
  const type = (item.model_type ?? '').trim()
  if (type && !isImageModelType(type)) reasons.push(`model_type not image: ${type}`)
  return reasons
}

function capabilitiesFromEndpoints(endpoints: string[]): CapabilityResult {
  const caps = new Set<ModelCapability>()
  const reasons: string[] = []
  const normalized = endpoints.map(e => e.trim()).filter(Boolean)

  if (normalized.length === 0) {
    return { capabilities: [], reasons: [] }
  }

  const hasOpenai = normalized.some(e => OPENAI_IMAGE_ENDPOINTS.has(e))
  const hasGemini = normalized.some(e => GEMINI_IMAGE_ENDPOINTS.has(e))
  const hasEdit = normalized.some(e => /编辑|edit/i.test(e))
  const hasGeneration = normalized.some(e => /绘图|generation|generations|dall-e/i.test(e))

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

  return { capabilities: [...caps], reasons }
}

export function resolveYunwuCapabilities(item: YunwuModelItem): CapabilityResult {
  const typeBlocks = blockReasonsFromModelType(item)
  const endpointBlocks = blockReasonsFromEndpoints(item.supported_endpoint_types ?? [])
  const allBlocks = [...typeBlocks, ...endpointBlocks]

  if (allBlocks.length > 0) {
    return { capabilities: [], reasons: allBlocks }
  }

  const { capabilities, reasons } = capabilitiesFromEndpoints(item.supported_endpoint_types ?? [])
  if (capabilities.length === 0) {
    return { capabilities: [], reasons: ['no recognized image generation endpoint'] }
  }

  return { capabilities: [...new Set(capabilities)], reasons }
}

export function isYunwuExecutableImageModel(item: YunwuModelItem): boolean {
  const { capabilities } = resolveYunwuCapabilities(item)
  if (capabilities.length === 0) return false
  return isImageModelType(item.model_type)
}
