/**
 * contract-driven 参数规范化。
 *
 * 输入：目标契约 + 用户显式参数 + 默认值提示。
 * 输出：契约允许发送的字段值，含 promptAdditions（MJ --ar/--stylize 之类）。
 *
 * 规则：
 * - 契约不支持的显式字段 → 拒绝（reason 中标出）。
 * - 契约支持但未提供 → 补契约默认；有多个候选默认时选择契约允许的最小/首个。
 * - 显式无效值（枚举不匹配、越界）→ 拒绝。
 * - Gemini/MJ 的 imageSize 大小写统一：发送层使用契约声明的大写 K；用户可传 1k/1K。
 */

import type {
  ImageContract,
  UserAspectRatio,
  UserResolutionLevel,
} from './types.js'
import { resolveOpenAiSize } from './openai-size.js'

export interface ContractExplicitParams {
  resolution?: string | number | null
  aspectRatio?: string | null
  imageSize?: string | null
  ar?: string | null
  stylize?: number | string | null
  quality?: string | null
  format?: string | null
  background?: string | null
  moderation?: string | null
  n?: number | null
  numImages?: number | null
  botType?: string | null
  responseFormat?: string | null
}

export interface ContractResolvedFields {
  /** 最终发送给 provider 的键值对（协议方言留给 provider 转换）。 */
  fields: Record<string, string | number>
  /** promptAppends（MJ --ar / --stylize 等）。 */
  promptAppends: string[]
  /** 最终 numImages（对 supportsN=false 的契约固定为 1）。 */
  numImages: number
  /** 未被采纳的显式参数原因（用于日志或错误消息）。 */
  rejected: Array<{ key: string; value: unknown; reason: string }>
  /** 展示层可读的规范化值。 */
  aspectRatio?: string
  resolution?: string
  imageSize?: string
}

export interface ContractResolveOptions {
  defaultNumImages?: number
  existingPrompt?: string
}

const ASPECT_RATIOS: UserAspectRatio[] = ['1:1', '4:3', '3:2', '16:9', '9:16', '2:3']
const RESOLUTION_LEVELS: UserResolutionLevel[] = ['1k', '2k', '4k']

export function resolveContractParams(
  contract: ImageContract,
  explicit: ContractExplicitParams,
  options: ContractResolveOptions = {},
): ContractResolvedFields {
  if (contract.protocol === 'openai') return resolveOpenAi(contract, explicit, options)
  if (contract.protocol === 'gemini') return resolveGemini(contract, explicit, options)
  return resolveMj(contract, explicit, options)
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

function resolveOpenAi(
  contract: ImageContract,
  explicit: ContractExplicitParams,
  options: ContractResolveOptions,
): ContractResolvedFields {
  const cap = contract.openai!
  const rejected: Array<{ key: string; value: unknown; reason: string }> = []
  const fields: Record<string, string | number> = {}
  let normalizedAspect: UserAspectRatio | undefined
  let normalizedResolution: string | undefined

  const aspectRatioRaw = explicit.aspectRatio ?? explicit.ar ?? ''
  const resolutionRaw = (typeof explicit.resolution === 'string' ? explicit.resolution : undefined)
    ?? (typeof explicit.imageSize === 'string' ? explicit.imageSize : undefined)
    ?? ''

  if (aspectRatioRaw) {
    const match = ASPECT_RATIOS.find((r) => r === aspectRatioRaw)
    if (!match) rejected.push({ key: 'aspectRatio', value: aspectRatioRaw, reason: '不在支持的比例枚举内' })
    else normalizedAspect = match
  }

  if (resolutionRaw) {
    const lower = String(resolutionRaw).toLowerCase()
    if (/^\d+x\d+$/i.test(lower)) {
      normalizedResolution = lower
    } else if (RESOLUTION_LEVELS.includes(lower as UserResolutionLevel)) {
      normalizedResolution = lower
    } else {
      rejected.push({ key: 'resolution', value: resolutionRaw, reason: '仅支持 1k/2k/4k 或数字x数字' })
    }
  }

  // 补默认：只写比例但未写分辨率时，若契约声明了 fixed 表就按最低支持等级补；
  // 反过来只写分辨率但未写比例时补 1:1（若契约存在该等级下的 1:1 固定 size）。
  // 均未提供时保留 auto/undefined，由 resolveOpenAiSize 处理。
  if (normalizedAspect !== undefined && normalizedResolution === undefined) {
    const table = cap.size?.fixedByResolutionAndAspect
    if (table) {
      const level = (RESOLUTION_LEVELS as string[]).find((lvl) => table[lvl as UserResolutionLevel]?.[normalizedAspect!])
      if (level) normalizedResolution = level
    }
  }
  if (normalizedResolution !== undefined && normalizedAspect === undefined) {
    const table = cap.size?.fixedByResolutionAndAspect
    if (table && (RESOLUTION_LEVELS as string[]).includes(normalizedResolution)) {
      const map = table[normalizedResolution as UserResolutionLevel]
      if (map?.['1:1']) normalizedAspect = '1:1'
      else if (map) {
        const first = Object.keys(map)[0] as UserAspectRatio | undefined
        if (first) normalizedAspect = first
      }
    }
  }

  const size = resolveOpenAiSize({
    ...(normalizedAspect !== undefined ? { aspectRatio: normalizedAspect } : {}),
    ...(normalizedResolution !== undefined ? { resolution: normalizedResolution } : {}),
    capability: cap.size,
  })

  if (!size.ok) {
    rejected.push({ key: 'size', value: `${normalizedAspect ?? ''}|${normalizedResolution ?? ''}`, reason: size.error })
  } else {
    fields.size = size.size
  }

  // quality / format / background / moderation：仅契约声明的枚举放行
  applyEnumField(explicit.quality, cap.qualities, 'quality', fields, rejected)
  applyEnumField(explicit.format, cap.formats, 'format', fields, rejected)
  applyEnumField(explicit.background, cap.backgrounds, 'background', fields, rejected)
  applyEnumField(explicit.moderation, cap.moderations, 'moderation', fields, rejected)

  // n 处理
  const nRequested = firstFinite(explicit.n, explicit.numImages, options.defaultNumImages, 1)
  const numImages = resolveN(contract, nRequested, rejected)

  return {
    fields,
    promptAppends: [],
    numImages,
    rejected,
    ...(normalizedAspect !== undefined ? { aspectRatio: normalizedAspect } : {}),
    ...(normalizedResolution !== undefined ? { resolution: normalizedResolution } : {}),
  }
}

function resolveN(
  contract: ImageContract,
  requested: number,
  _rejected: Array<{ key: string; value: unknown; reason: string }>,
): number {
  const cap = contract.openai!
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.floor(v)))
  const productMax = clamp(cap.maxN ?? 4, 1, 4)
  // supportsN=false 表示单请求 n 字段固定为 1；用户仍可请求多张，由 Provider 通过
  // 多次 n=1 调用累积，不视为参数错误。
  if (!cap.supportsN) {
    return clamp(requested, 1, 4)
  }
  return clamp(requested, 1, productMax)
}

function applyEnumField(
  value: unknown,
  allowed: string[] | undefined,
  key: string,
  fields: Record<string, string | number>,
  rejected: Array<{ key: string; value: unknown; reason: string }>,
) {
  if (value === undefined || value === null || value === '') return
  if (!allowed || allowed.length === 0) {
    rejected.push({ key, value, reason: '当前契约不支持该字段' })
    return
  }
  const str = String(value)
  if (!allowed.includes(str)) {
    rejected.push({ key, value, reason: `仅支持：${allowed.join('/')}` })
    return
  }
  fields[key] = str
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

function resolveGemini(
  contract: ImageContract,
  explicit: ContractExplicitParams,
  options: ContractResolveOptions,
): ContractResolvedFields {
  const cap = contract.gemini!
  const rejected: Array<{ key: string; value: unknown; reason: string }> = []
  const fields: Record<string, string | number> = {}
  let normalizedAspect: UserAspectRatio | undefined
  let normalizedImageSize: string | undefined

  const aspectRatioRaw = explicit.aspectRatio ?? explicit.ar ?? ''
  if (aspectRatioRaw) {
    const match = ASPECT_RATIOS.find((r) => r === aspectRatioRaw)
    if (!match) {
      rejected.push({ key: 'aspectRatio', value: aspectRatioRaw, reason: '不在支持的比例枚举内' })
    } else if (cap.imageConfig.enabled) {
      const supported = cap.imageConfig.aspectRatios
      if (supported && supported.length > 0 && !supported.includes(match)) {
        rejected.push({ key: 'aspectRatio', value: match, reason: `当前契约支持：${supported.join('/')}` })
      } else {
        fields.aspectRatio = match
        normalizedAspect = match
      }
    } else {
      rejected.push({ key: 'aspectRatio', value: match, reason: '当前编辑契约不发送 imageConfig' })
    }
  }

  const rawImageSize = (typeof explicit.imageSize === 'string' ? explicit.imageSize : undefined)
    ?? (typeof explicit.resolution === 'string' ? explicit.resolution : undefined)
    ?? ''
  if (rawImageSize) {
    if (!cap.imageConfig.enabled) {
      rejected.push({ key: 'imageSize', value: rawImageSize, reason: '当前编辑契约不发送 imageConfig' })
    } else {
      const supported = cap.imageConfig.imageSizes ?? []
      if (supported.length === 0) {
        rejected.push({ key: 'imageSize', value: rawImageSize, reason: '当前契约不接受 imageSize（发送将被拒绝）' })
      } else {
        const upper = String(rawImageSize).toUpperCase()
        const match = supported.find((s) => s.toUpperCase() === upper)
        if (!match) {
          rejected.push({ key: 'imageSize', value: rawImageSize, reason: `仅支持：${supported.join('/')}` })
        } else {
          fields.imageSize = match
          normalizedImageSize = match
        }
      }
    }
  }

  // 契约默认补全：
  // - imageConfig.enabled=false（如编辑契约）→ 不补任何 imageConfig 字段。
  // - imageConfig.enabled=true → 未提供 aspectRatio 补 1:1；
  //   若契约声明的 imageSizes 非空且未标记 optional，且用户未提供 imageSize，
  //   补首个（1K）。imageSizeOptional=true 或 imageSizes=[]（云雾 2.5）时不补 imageSize。
  if (cap.imageConfig.enabled) {
    if (fields.aspectRatio === undefined) {
      const supported = cap.imageConfig.aspectRatios
      const defaultAspect: UserAspectRatio = '1:1'
      if (!supported || supported.length === 0 || supported.includes(defaultAspect)) {
        fields.aspectRatio = defaultAspect
        normalizedAspect = defaultAspect
      }
    }
    if (fields.imageSize === undefined) {
      const sizes = cap.imageConfig.imageSizes ?? []
      if (sizes.length > 0 && cap.imageConfig.imageSizeOptional !== true) {
        fields.imageSize = sizes[0]!
        normalizedImageSize = sizes[0]!
      }
    }
  }

  // response_format=url：仅云雾扩展支持
  const responseFormatRaw = explicit.responseFormat ?? undefined
  if (responseFormatRaw) {
    if (!cap.supportsYunwuResponseFormatUrl) {
      rejected.push({ key: 'responseFormat', value: responseFormatRaw, reason: '当前契约不支持 response_format 扩展' })
    } else if (responseFormatRaw !== 'url') {
      rejected.push({ key: 'responseFormat', value: responseFormatRaw, reason: '仅支持 response_format=url' })
    } else {
      fields.responseFormat = 'url'
    }
  }

  const numImages = clampNumImages(firstFinite(explicit.n, explicit.numImages, options.defaultNumImages, 1))

  return {
    fields,
    promptAppends: [],
    numImages,
    rejected,
    ...(normalizedAspect !== undefined ? { aspectRatio: normalizedAspect } : {}),
    ...(normalizedImageSize !== undefined ? { imageSize: normalizedImageSize, resolution: normalizedImageSize.toLowerCase() } : {}),
  }
}

// ---------------------------------------------------------------------------
// MJ
// ---------------------------------------------------------------------------

function resolveMj(
  contract: ImageContract,
  explicit: ContractExplicitParams,
  options: ContractResolveOptions,
): ContractResolvedFields {
  const cap = contract.mj!
  const rejected: Array<{ key: string; value: unknown; reason: string }> = []
  const fields: Record<string, string | number> = {}
  const promptAppends: string[] = []

  const arRaw = explicit.aspectRatio ?? explicit.ar ?? ''
  let normalizedAspect: UserAspectRatio | undefined
  let arProvidedValid = false
  if (arRaw) {
    const match = ASPECT_RATIOS.find((r) => r === arRaw)
    if (!match) {
      rejected.push({ key: 'ar', value: arRaw, reason: '不在支持的比例枚举内' })
    } else if (!cap.supportsAspectRatio) {
      rejected.push({ key: 'ar', value: match, reason: '当前契约不支持 --ar' })
    } else if (cap.aspectRatios && !cap.aspectRatios.includes(match)) {
      rejected.push({ key: 'ar', value: match, reason: `当前契约支持：${cap.aspectRatios.join('/')}` })
    } else {
      normalizedAspect = match
      arProvidedValid = true
      if (!promptContainsFlag(options.existingPrompt, ['--ar'])) {
        promptAppends.push(`--ar ${match}`)
      }
    }
  }

  let stylizeProvidedValid = false
  if (explicit.stylize !== undefined && explicit.stylize !== null && explicit.stylize !== '') {
    const num = Number(explicit.stylize)
    if (!cap.supportsStylize) {
      rejected.push({ key: 'stylize', value: explicit.stylize, reason: '当前契约不支持 --stylize' })
    } else if (!Number.isFinite(num)) {
      rejected.push({ key: 'stylize', value: explicit.stylize, reason: '需为数字' })
    } else if (num < (cap.stylizeMin ?? 0) || num > (cap.stylizeMax ?? 1000)) {
      rejected.push({ key: 'stylize', value: num, reason: `需在 ${cap.stylizeMin ?? 0}-${cap.stylizeMax ?? 1000} 之间` })
    } else {
      stylizeProvidedValid = true
      if (!promptContainsFlag(options.existingPrompt, ['--stylize', '--s'])) {
        promptAppends.push(`--stylize ${num}`)
      }
    }
  }

  // 契约默认补全：MJ Imagine 默认 --ar 1:1 与 --stylize 100，
  // 只在契约支持且用户未提供有效值时补，且 prompt 本身或已收集 append 中未含同类 flag。
  if (!arProvidedValid && cap.supportsAspectRatio) {
    const supported = cap.aspectRatios
    const defaultAr: UserAspectRatio = '1:1'
    if (!supported || supported.includes(defaultAr)) {
      const already = promptContainsFlag(options.existingPrompt, ['--ar'])
        || promptAppends.some((a) => /^--ar\b/i.test(a))
      if (!already) {
        promptAppends.push(`--ar ${defaultAr}`)
        normalizedAspect = defaultAr
      }
    }
  }
  if (!stylizeProvidedValid && cap.supportsStylize) {
    const alreadyStylize = promptContainsFlag(options.existingPrompt, ['--stylize', '--s'])
      || promptAppends.some((a) => /^--(stylize|s)\b/i.test(a))
    if (!alreadyStylize) {
      const min = cap.stylizeMin ?? 0
      const max = cap.stylizeMax ?? 1000
      const defaultStylize = Math.min(max, Math.max(min, 100))
      promptAppends.push(`--stylize ${defaultStylize}`)
    }
  }

  const botTypeRaw = explicit.botType ?? undefined
  const supportedBots = cap.botTypes ?? ['MID_JOURNEY']
  if (botTypeRaw) {
    if (!supportedBots.includes(botTypeRaw as any)) {
      rejected.push({ key: 'botType', value: botTypeRaw, reason: `仅支持：${supportedBots.join('/')}` })
    } else {
      fields.botType = botTypeRaw
    }
  } else {
    fields.botType = supportedBots[0]!
  }

  // MJ 不发 n 字段（Imagine 单任务），但 provider 可能会拆多次调用。
  const numImages = clampNumImages(firstFinite(explicit.n, explicit.numImages, options.defaultNumImages, 1))

  return {
    fields,
    promptAppends,
    numImages,
    rejected,
    ...(normalizedAspect !== undefined ? { aspectRatio: normalizedAspect } : {}),
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function firstFinite(...values: unknown[]): number {
  for (const value of values) {
    const num = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(num)) return num
  }
  return 1
}

function clampNumImages(raw: number): number {
  const n = Math.floor(raw)
  return Math.min(4, Math.max(1, Number.isFinite(n) ? n : 1))
}

function promptContainsFlag(prompt: string | undefined, flags: string[]): boolean {
  if (!prompt) return false
  for (const flag of flags) {
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`).test(prompt)) return true
  }
  return false
}
