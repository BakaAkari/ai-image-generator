/**
 * OpenAI 尺寸解析器 —— 按契约 OpenAiSizeCapability 从
 * (resolution level | 自定义 WxH) + aspectRatio 精确落位到 `size`。
 *
 * 规则：
 * - 显式自定义 `NxM` → 校验契约的 customSizeLimits；不符合直接报错。
 * - resolution 预设 + aspectRatio 组合优先查 fixedByResolutionAndAspect；
 *   没有精确固定映射时，若契约允许 auto，返回 'auto' 并记录理由；
 *   否则报错，不静默降级到近似比例（避免 4:3 变 3:2 之类的悄悄错配）。
 * - 只给 aspectRatio 而未给 resolution 时，按“最低支持等级 + 该比例”查表；
 *   若该比例只在 2K/4K 等级有映射，直接使用其中最低的一个；仍无则报错。
 */

import type { OpenAiSizeCapability, UserAspectRatio, UserResolutionLevel } from './types.js'

export interface ResolveOpenAiSizeInput {
  aspectRatio?: string
  resolution?: string
  capability: OpenAiSizeCapability | undefined
}

export type ResolveOpenAiSizeResult =
  | { ok: true; size: string; explanation?: string }
  | { ok: false; error: string }

const RESOLUTION_LEVELS: UserResolutionLevel[] = ['1k', '2k', '4k']

export function resolveOpenAiSize(input: ResolveOpenAiSizeInput): ResolveOpenAiSizeResult {
  const capability = input.capability
  if (!capability) {
    return { ok: false, error: '当前契约未声明 size 能力' }
  }

  const resolutionRaw = typeof input.resolution === 'string' ? input.resolution.trim() : ''
  const aspectRatioRaw = typeof input.aspectRatio === 'string' ? input.aspectRatio.trim() : ''

  // 自定义 WxH
  if (/^\d+x\d+$/i.test(resolutionRaw)) {
    return validateCustomSize(resolutionRaw.toLowerCase(), capability)
  }

  const resolution = normalizeResolutionLevel(resolutionRaw)
  const aspectRatio = normalizeAspectRatio(aspectRatioRaw)

  if (resolution && aspectRatio) {
    const size = capability.fixedByResolutionAndAspect?.[resolution]?.[aspectRatio]
    if (size) return { ok: true, size }
    return {
      ok: false,
      error: `当前契约在 ${resolution.toUpperCase()} + ${aspectRatio} 组合下没有对应固定 size；请调整比例或分辨率`,
    }
  }

  // 只有比例：找最低支持等级的固定 size
  if (aspectRatio) {
    for (const level of RESOLUTION_LEVELS) {
      const size = capability.fixedByResolutionAndAspect?.[level]?.[aspectRatio]
      if (size) return { ok: true, size }
    }
    return { ok: false, error: `当前契约不支持比例 ${aspectRatio}` }
  }

  // 只有分辨率：取该等级 1:1
  if (resolution) {
    const size = capability.fixedByResolutionAndAspect?.[resolution]?.['1:1']
    if (size) return { ok: true, size }
    return { ok: false, error: `当前契约在 ${resolution.toUpperCase()} 分辨率下没有默认 1:1 size` }
  }

  // 均未提供：契约默认（若含 auto 则 auto，否则 1024x1024）
  if (capability.supportsAuto) return { ok: true, size: 'auto' }
  const defaultSize = capability.fixedByResolutionAndAspect?.['1k']?.['1:1']
    ?? capability.fixedSizes[0]
  if (defaultSize) return { ok: true, size: defaultSize }
  return { ok: false, error: '当前契约无法推断默认 size' }
}

function validateCustomSize(size: string, capability: OpenAiSizeCapability): ResolveOpenAiSizeResult {
  if (!capability.customSizeLimits) {
    if (capability.fixedSizes.includes(size)) return { ok: true, size }
    return { ok: false, error: `当前契约不支持自定义尺寸 ${size}` }
  }
  const parts = size.split('x')
  const width = Number(parts[0])
  const height = Number(parts[1])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ok: false, error: `尺寸格式非法：${size}` }
  }
  const limits = capability.customSizeLimits
  if (width % limits.step !== 0 || height % limits.step !== 0) {
    return { ok: false, error: `宽高均需为 ${limits.step} 的倍数：${size}` }
  }
  if (width > limits.maxSide || height > limits.maxSide) {
    return { ok: false, error: `最长边不可超过 ${limits.maxSide}px：${size}` }
  }
  const longSide = Math.max(width, height)
  const shortSide = Math.min(width, height)
  if (longSide / shortSide > limits.maxRatio + 1e-6) {
    return { ok: false, error: `长短边比例不可超过 ${limits.maxRatio}:1：${size}` }
  }
  const pixels = width * height
  if (pixels < limits.minPixels || pixels > limits.maxPixels) {
    return {
      ok: false,
      error: `总像素需在 ${limits.minPixels}..${limits.maxPixels} 之间：${size}（当前 ${pixels}）`,
    }
  }
  return { ok: true, size }
}

function normalizeResolutionLevel(raw: string): UserResolutionLevel | undefined {
  const lower = raw.toLowerCase()
  return (RESOLUTION_LEVELS as string[]).includes(lower) ? (lower as UserResolutionLevel) : undefined
}

function normalizeAspectRatio(raw: string): UserAspectRatio | undefined {
  const aspects: UserAspectRatio[] = ['1:1', '4:3', '3:2', '16:9', '9:16', '2:3']
  return (aspects as string[]).includes(raw) ? (raw as UserAspectRatio) : undefined
}
