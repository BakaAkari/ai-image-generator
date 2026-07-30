/**
 * 向导参数契约过滤 —— 按具体模型契约收窄 PROTOCOL_PARAMS 的协议级参数定义。
 *
 * 动机：向导参数页此前对所有模型展示协议全集（如宽高比恒为 6 种），
 * 但具体契约未必支持全部选项（如某 OpenAI 契约 1K + 16:9 无固定 size），
 * 用户选完要到生成路径才报错。这里在契约层提供统一的过滤入口：
 * - 不可用的枚举选项直接从向导选项列表中移除；
 * - 契约不支持的参数（如 supportsN=false 的生成张数、imageConfig 关闭的分辨率/比例）整体移除；
 * - 数字参数按契约上下限收窄；
 * - 过滤后若协议默认值不再合法，替换为首个可选项，保证「跳过」一定是合法组合。
 *
 * 无契约（未知模型）时保守返回原列表，与生成路径的 legacy 分支行为一致。
 */

import type { ParamDef } from '../shared/protocol-params.js'
import type { ImageContract, UserAspectRatio, UserResolutionLevel } from './types.js'

/** 按契约能力收窄参数定义；contract 缺失时原样返回（保守分支）。 */
export function filterParamsForContract(
  contract: ImageContract | undefined,
  params: ParamDef[],
): ParamDef[] {
  if (!contract) return params
  if (contract.protocol === 'openai' && contract.openai) {
    return filterOpenAiParams(params, contract)
  }
  if (contract.protocol === 'gemini' && contract.gemini) {
    return filterGeminiParams(params, contract)
  }
  if (contract.protocol === 'mj' && contract.mj) {
    return filterMjParams(params, contract)
  }
  return params
}

// ─── OpenAI ──────────────────────────────────────────────────────────────────

function filterOpenAiParams(params: ParamDef[], contract: ImageContract): ParamDef[] {
  const cap = contract.openai
  const size = cap?.size
  const table = size?.fixedByResolutionAndAspect

  // 契约未声明 size 能力：保守保留（与 resolveOpenAiSize 报错路径区分——
  // 该错误在生成路径 fail-closed，向导层不改变现状行为）
  const levels = table
    ? (Object.keys(table) as UserResolutionLevel[]).filter(l => Object.keys(table[l] ?? {}).length > 0)
    : undefined
  const ratios = table
    ? [...new Set(levels!.flatMap(l => Object.keys(table[l] ?? {}) as UserAspectRatio[]))]
    : undefined

  const result: ParamDef[] = []
  for (const p of params) {
    if (p.key === 'resolution' && levels) {
      const filtered = filterEnumOptions(p, levels)
      if (filtered) result.push(filtered)
      continue // 过滤后无可用等级 → 移除该参数（极端情况，正常不会发生）
    }
    if (p.key === 'aspectRatio' && ratios) {
      const filtered = filterEnumOptions(p, ratios)
      if (filtered) result.push(filtered)
      continue
    }
    if (p.key === 'n' && cap) {
      if (cap.supportsN === false) continue // 契约不支持 n → 移除「生成张数」
      if (cap.maxN != null && (p.max == null || cap.maxN < p.max)) {
        result.push({ ...p, max: cap.maxN, default: Math.min(Number(p.default) || 1, cap.maxN) })
        continue
      }
    }
    result.push(p)
  }
  return result
}

// ─── Gemini ──────────────────────────────────────────────────────────────────

function filterGeminiParams(params: ParamDef[], contract: ImageContract): ParamDef[] {
  const imageConfig = contract.gemini!.imageConfig
  // imageConfig 整体关闭（如编辑契约）→ 分辨率与宽高比都不发送，移除
  if (!imageConfig.enabled) {
    return params.filter(p => p.key !== 'imageSize' && p.key !== 'aspectRatio')
  }

  const result: ParamDef[] = []
  for (const p of params) {
    if (p.key === 'imageSize') {
      // imageSizes 为空数组 = 契约不发送 imageSize（如云雾 2.5）→ 移除分辨率参数
      if (imageConfig.imageSizes && imageConfig.imageSizes.length === 0) continue
      if (imageConfig.imageSizes && imageConfig.imageSizes.length > 0) {
        const filtered = filterEnumOptions(p, imageConfig.imageSizes)
        if (filtered) result.push(filtered)
        continue
      }
      result.push(p)
      continue
    }
    if (p.key === 'aspectRatio') {
      // aspectRatios 空数组/未声明 = 任意（不校验）→ 保留完整列表
      if (imageConfig.aspectRatios && imageConfig.aspectRatios.length > 0) {
        const filtered = filterEnumOptions(p, imageConfig.aspectRatios)
        if (filtered) result.push(filtered)
        continue
      }
      result.push(p)
      continue
    }
    result.push(p)
  }
  return result
}

// ─── Midjourney ──────────────────────────────────────────────────────────────

function filterMjParams(params: ParamDef[], contract: ImageContract): ParamDef[] {
  const cap = contract.mj!
  const result: ParamDef[] = []
  for (const p of params) {
    if (p.key === 'ar') {
      if (!cap.supportsAspectRatio) continue
      if (cap.aspectRatios && cap.aspectRatios.length > 0) {
        const filtered = filterEnumOptions(p, cap.aspectRatios)
        if (filtered) result.push(filtered)
        continue
      }
      result.push(p)
      continue
    }
    if (p.key === 'stylize') {
      if (!cap.supportsStylize) continue
      const min = cap.stylizeMin ?? p.min
      const max = cap.stylizeMax ?? p.max
      if (min !== p.min || max !== p.max) {
        const def = Number(p.default)
        result.push({
          ...p,
          min,
          max,
          default: Number.isFinite(def)
            ? Math.min(Math.max(def, min ?? def), max ?? def)
            : p.default,
        })
        continue
      }
      result.push(p)
      continue
    }
    result.push(p)
  }
  return result
}

// ─── 工具 ────────────────────────────────────────────────────────────────────

/**
 * 过滤枚举参数的选项与展示文案；过滤后为空返回 undefined（调用方决定移除该参数）。
 * 默认值不在过滤结果中时替换为首个可选项，保证「跳过」得到合法值。
 */
function filterEnumOptions(p: ParamDef, allowed: string[]): ParamDef | undefined {
  if (!p.options?.length) return p
  const keepIdx = p.options
    .map((opt, i) => ({ opt, i }))
    .filter(({ opt }) => allowed.includes(opt))
    .map(({ i }) => i)
  if (!keepIdx.length) return undefined
  const options = keepIdx.map(i => p.options![i])
  const displayValues = p.displayValues ? keepIdx.map(i => p.displayValues![i]) : undefined
  const defaultValue = options.includes(String(p.default)) ? p.default : options[0]
  return { ...p, options, displayValues, default: defaultValue }
}
