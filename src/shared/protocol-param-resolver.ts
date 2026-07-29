/**
 * 协议参数规范化 + 缺失值自动补全（公共层）。
 *
 * 单一事实源：所有命令入口 / 向导 / ChatLuna / YesImBot bridge 共享同一函数，
 * 依据 catalog route 决定的协议（openai / gemini / mj）从 PROTOCOL_PARAMS
 * 读取支持参数及默认值。
 *
 * 行为约定：
 * - 用户显式值优先；缺失可选参数使用协议默认值。
 * - 仅发送该协议支持的参数；未知协议保守：不盲补字段，不生成 promptAdditions。
 * - Gemini imageSize 大小写统一（1k → 1K / 2k → 2K / 4k → 4K）。
 * - OpenAI resolution 除枚举（1k/2k/4k）外，还允许 `数字x数字` 自定义分辨率
 *   （如 1024x2048），与 provider isCustomResolution 行为一致；gemini/mj 不放宽。
 * - MJ promptAppend（ar / stylize）转成 `--ar` / `--stylize` prompt 后缀；
 *   若 prompt 中已存在同类 flag（含 `--s` 别名）则不重复追加。
 * - 显式提供的无效值不使用默认掩盖，直接丢弃（保留现有 provider 端安全行为）。
 */

import { PROTOCOL_PARAMS } from './protocol-params.js'
import type { ParamDef } from './protocol-params.js'

export interface ProtocolExplicitParams {
  resolution?: string | number | null
  aspectRatio?: string | null
  imageSize?: string | null
  ar?: string | null
  stylize?: number | string | null
  n?: number | null
  numImages?: number | null
}

export interface ProtocolParamOptions {
  /** 未设置 n 或该协议无 n 参数时，用于兜底张数。 */
  defaultNumImages?: number
  /** 现有 prompt 文本，用于 MJ promptAppend 去重。 */
  existingPromptAppends?: string
}

export interface ResolvedProtocolParams {
  protocol: string | undefined
  /** 是否命中 PROTOCOL_PARAMS 定义 */
  known: boolean
  /** 键为 ParamDef.key 的最终参数值；promptAppend 类参数不出现在这里 */
  params: Record<string, string | number>
  /** 需要拼接到 prompt 尾部的 MJ 风格 flag（已去重） */
  promptAdditions: string[]
  /** 便捷字段：normalized aspectRatio */
  aspectRatio?: string
  /** 便捷字段：normalized resolution（对 gemini 为 imageSize 的小写别名） */
  resolution?: string
  /** gemini 专用：大小写保持协议原样的 imageSize（如 '1K'） */
  imageSize?: string
  /** 最终图片数量（1-4，已 clamp） */
  numImages: number
}

/** 已知别名映射：某些参数在不同协议里同义 */
const KEY_ALIASES: Record<string, string[]> = {
  resolution: ['resolution', 'imageSize'],
  imageSize: ['imageSize', 'resolution'],
  aspectRatio: ['aspectRatio', 'ar'],
  ar: ['ar', 'aspectRatio'],
  n: ['n', 'numImages'],
}

const MJ_FLAG_ALIASES: Record<string, string[]> = {
  ar: ['--ar'],
  stylize: ['--stylize', '--s'],
}

function readExplicit(explicit: ProtocolExplicitParams, key: string): unknown {
  const aliases = KEY_ALIASES[key] ?? [key]
  for (const alias of aliases) {
    const value = (explicit as Record<string, unknown>)[alias]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function normalizeEnumValue(
  def: ParamDef,
  raw: unknown,
  protocol: string | undefined,
): string | undefined {
  if (raw === undefined || raw === null) return undefined
  const str = String(raw).trim()
  if (!str) return undefined
  const options = def.options ?? []
  const match = options.find((opt) => opt.toLowerCase() === str.toLowerCase())
  if (match) return match
  // OpenAI resolution 允许自定义 `数字x数字`（如 1024x2048）——与 provider 的
  // isCustomResolution 保持一致；其他协议不受此放宽影响。
  if (protocol === 'openai' && def.key === 'resolution' && /^\d+x\d+$/i.test(str)) {
    return str.toLowerCase()
  }
  return undefined
}

function normalizeNumberValue(def: ParamDef, raw: unknown): number | undefined {
  const numeric = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(numeric)) return undefined
  if (def.min !== undefined && numeric < def.min) return undefined
  if (def.max !== undefined && numeric > def.max) return undefined
  return numeric
}

function clampNumImages(raw: unknown, fallback: number): number {
  const numeric = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(numeric)) return Math.min(4, Math.max(1, Math.floor(fallback) || 1))
  return Math.min(4, Math.max(1, Math.floor(numeric)))
}

function promptAlreadyContainsFlag(existing: string, aliases: string[]): boolean {
  if (!existing) return false
  for (const flag of aliases) {
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`)
    if (re.test(existing)) return true
  }
  return false
}

export function resolveProtocolParams(
  protocol: string | undefined,
  explicit: ProtocolExplicitParams = {},
  options: ProtocolParamOptions = {},
): ResolvedProtocolParams {
  const defaultNumImages = options.defaultNumImages ?? 1
  const def = protocol ? PROTOCOL_PARAMS[protocol] : undefined

  if (!def) {
    const explicitN = readExplicit(explicit, 'n')
    return {
      protocol,
      known: false,
      params: {},
      promptAdditions: [],
      numImages: clampNumImages(explicitN, defaultNumImages),
    }
  }

  const params: Record<string, string | number> = {}
  const promptAdditions: string[] = []
  let hasNParam = false
  const existingAppends = options.existingPromptAppends ?? ''

  for (const paramDef of def.params) {
    if (paramDef.key === 'n') hasNParam = true

    const rawExplicit = readExplicit(explicit, paramDef.key)
    let value: string | number | undefined

    if (rawExplicit !== undefined) {
      if (paramDef.type === 'enum') {
        value = normalizeEnumValue(paramDef, rawExplicit, protocol)
      } else {
        value = normalizeNumberValue(paramDef, rawExplicit)
      }
      // 显式无效值：保留 provider 端安全行为，不用默认掩盖 → 直接跳过
      if (value === undefined) continue
    } else {
      value = paramDef.default
    }

    if (paramDef.promptAppend) {
      const flagAliases = MJ_FLAG_ALIASES[paramDef.key] ?? [`--${paramDef.key}`]
      const primaryFlag = flagAliases[0]!
      if (!promptAlreadyContainsFlag(existingAppends, flagAliases)
        && !promptAlreadyContainsFlag(promptAdditions.join(' '), flagAliases)) {
        promptAdditions.push(`${primaryFlag} ${value}`)
      }
      continue
    }

    params[paramDef.key] = value
  }

  let aspectRatio: string | undefined
  let resolution: string | undefined
  let imageSize: string | undefined

  if (typeof params.aspectRatio === 'string') aspectRatio = params.aspectRatio
  if (typeof params.resolution === 'string') resolution = params.resolution
  if (typeof params.imageSize === 'string') {
    imageSize = params.imageSize
    resolution = imageSize.toLowerCase()
  }

  const numImages = hasNParam
    ? clampNumImages(params.n, defaultNumImages)
    : clampNumImages(readExplicit(explicit, 'n'), defaultNumImages)

  return {
    protocol,
    known: true,
    params,
    promptAdditions,
    ...(aspectRatio !== undefined ? { aspectRatio } : {}),
    ...(resolution !== undefined ? { resolution } : {}),
    ...(imageSize !== undefined ? { imageSize } : {}),
    numImages,
  }
}
