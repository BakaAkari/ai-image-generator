/**
 * 从 yunwu 模型元数据推导图像生成能力。
 *
 * 只根据 `supported_endpoint_types` 和 `model_type` 做出显式判断，
 * 未知能力 fail-closed：不产生默认能力。
 */

import type { ModelCapability } from '../../catalog/model-catalog.js'
import type { YunwuModelItem } from './raw-types.js'

export interface CapabilityResult {
  capabilities: ModelCapability[]
  reasons: string[]
}

/** OpenAI 图像生成相关 endpoint 关键字 */
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

/** Gemini 图像生成相关 endpoint 关键字 */
const GEMINI_IMAGE_ENDPOINTS = new Set([
  'gemini',
])

function endpointNamesMatch(endpoints: string[], names: Set<string>): boolean {
  return endpoints.some(e => names.has(e))
}

function isImageModelType(modelType?: string): boolean {
  if (!modelType) return false
  return /图像|图片|image/i.test(modelType)
}

function isAudioVideoModelType(modelType?: string): boolean {
  if (!modelType) return false
  return /音视频|视频|audio|video/i.test(modelType)
}

/**
 * 根据 endpoint 名称映射到能力。
 * 只返回明确支持的能力；不认识的 endpoint 不产生能力。
 */
function capabilitiesFromEndpoints(endpoints: string[]): CapabilityResult {
  const capabilities: ModelCapability[] = []
  const reasons: string[] = []
  const normalized = endpoints.map(e => e.trim()).filter(Boolean)

  if (normalized.length === 0) {
    return { capabilities: [], reasons: [] }
  }

  const hasOpenai = endpointNamesMatch(normalized, OPENAI_IMAGE_ENDPOINTS)
  const hasGemini = endpointNamesMatch(normalized, GEMINI_IMAGE_ENDPOINTS)

  if (hasOpenai) {
    // 编辑类 endpoint 明确为 image-edit；生成类为 text-to-image / image-to-image
    if (normalized.some(e => /编辑|edit/i.test(e))) {
      capabilities.push('image-edit')
      reasons.push('openai-edit endpoint')
    }
    if (normalized.some(e => /绘图|generation|generations|dall-e/i.test(e)) && !/编辑|edit/i.test(e))) {
      capabilities.push('text-to-image', 'image-to-image')
      reasons.push('openai-generation endpoint')
    }
    // 兜底 openai 图像 endpoint 但未命中细分：保守给 text-to-image
    if (capabilities.length === 0) {
      capabilities.push('text-to-image')
      reasons.push('openai image endpoint')
    }
  }

  if (hasGemini) {
    capabilities.push('text-to-image', 'image-to-image')
    reasons.push('gemini image endpoint')
  }

  return { capabilities: [...new Set(capabilities)], reasons }
}

/**
 * 从 model_type 中识别明确不是生成模型的类型，返回阻断原因。
 */
function blockReasonsFromModelType(item: YunwuModelItem): string[] {
  const reasons: string[] = []
  const type = (item.model_type ?? '').trim()

  if (type && !isImageModelType(type)) {
    reasons.push(`model_type not image: ${type}`)
  }

  return reasons
}

/**
 * 从 supported_endpoint_types 中识别明确不是生成能力的 endpoint，返回阻断原因。
 */
function blockReasonsFromEndpoints(endpoints: string[]): string[] {
  const reasons: string[] = []
  const normalized = endpoints.map(e => e.trim()).filter(Boolean)

  if (normalized.length === 0) {
    return reasons
  }

  const nonGenerationEndpoints = [
    { pattern: /数字人|avatar|image2video|image-to-video|video/, reason: 'avatar/video endpoint' },
    { pattern: /图像识别|识别|recognition|recognize|vision/, reason: 'image recognition endpoint' },
    { pattern: /上传|upload/, reason: 'upload endpoint' },
    { pattern: /图片模板|image.template|template/, reason: 'image template endpoint' },
  ]

  for (const endpoint of normalized) {
    for (const { pattern, reason } of nonGenerationEndpoints) {
      if (pattern.test(endpoint)) {
        reasons.push(`${reason}: ${endpoint}`)
      }
    }
  }

  return reasons
}

/**
 * 解析 yunwu 模型能力。
 *
 * 规则：
 * 1. 先检查是否有明确的非生成能力/类型，若有则阻断。
 * 2. 再按 supported_endpoint_types 推导正向能力。
 * 3. 若仍无能力，返回空能力（fail-closed）。
 */
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

/**
 * 判断 yunwu 模型是否属于可执行图像生成模型。
 *
 * 必要条件：model_type 为图像类型、且存在明确的图像生成 endpoint。
 */
export function isYunwuExecutableImageModel(item: YunwuModelItem): boolean {
  const { capabilities } = resolveYunwuCapabilities(item)
  if (capabilities.length === 0) return false
  return isImageModelType(item.model_type)
}
