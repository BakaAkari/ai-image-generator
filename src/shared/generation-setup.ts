/**
 * 生成请求上下文的公共构建层。
 *
 * 所有入口（普通命令、Prompt/style 快捷命令、交互向导、ChatLuna bridge、YesImBot bridge）
 * 都调用 `buildProtocolRequestContext`：
 *
 * 1. 根据 catalog route 决定的协议（openai / gemini / mj）从 PROTOCOL_PARAMS 读取参数定义；
 * 2. 用户显式值优先；缺失可选参数补齐协议默认值；
 * 3. 仅发送该协议支持的参数；未知协议保持保守，不盲补字段；
 * 4. MJ 的 ar/stylize 会被规范化为 `--ar` / `--stylize` prompt 追加，并按 flag 去重；
 * 5. Gemini 的 imageSize 大小写在此处统一（1k → 1K），
 *    ImageRequestContext.resolution 仍以小写返回，交由 Gemini Provider 内部映射为最终 imageSize。
 */

import type {
  ImageProvider,
  ImageRequestContext,
  ModelMappingConfig,
  ProviderType,
} from './types.js'
import type { ProtocolExplicitParams } from './protocol-param-resolver.js'
import { resolveProtocolParams } from './protocol-param-resolver.js'
import type { ContractOperation } from '../contracts/types.js'
import { getContractById } from '../contracts/registry.js'
import { resolveContractParams } from '../contracts/param-resolver.js'

export interface BuildProtocolRequestContextInput {
  /** 已识别的协议（由 catalog route 决定）；未知协议传 undefined 即可，走保守分支。 */
  protocol?: string
  supplier?: ImageProvider
  modelMapping?: ModelMappingConfig
  routeId?: string
  /** 已定位的契约 id（yunwu.openai.gpt-image-2.generate 等）。命中时走 contract-driven 分支。 */
  contractId?: string
  /** 当前操作类型，缺省 text-to-image。 */
  operation?: ContractOperation
  /** 用户在命令、向导或工具入参中显式提供的参数。 */
  explicit?: ProtocolExplicitParams
  /** 缺失 n 时的兜底张数（一般来自 config.defaultNumImages）。 */
  defaultNumImages?: number
  /** 现有 prompt 文本（用于 MJ 后缀 flag 去重）。 */
  existingPrompt?: string
}

export interface BuildProtocolRequestContextResult {
  requestContext: ImageRequestContext
  promptAdditions: string[]
  numImages: number
  known: boolean
  /** 若走了 contract-driven 分支，返回契约拒绝的显式参数（供上层报错/日志）。 */
  rejectedParams?: Array<{ key: string; value: unknown; reason: string }>
}

/**
 * 用户显式参数被契约拒绝时抛出的错误。
 * 五入口（普通命令、style、wizard、ChatLuna、YesImBot）在计费预授权与
 * provider 调用之前必须拦截并 fail-closed。
 */
export class ContractRejectedParamsError extends Error {
  constructor(public readonly rejected: Array<{ key: string; value: unknown; reason: string }>) {
    super(formatRejectedMessage(rejected))
    this.name = 'ContractRejectedParamsError'
  }
}

function formatRejectedMessage(
  rejected: Array<{ key: string; value: unknown; reason: string }>,
): string {
  const lines = rejected.map((r) => `- ${r.key}=${safeStringify(r.value)}｜${r.reason}`)
  return ['参数不被当前模型/契约接受', '', ...lines].join('\n')
}

function safeStringify(value: unknown): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function buildProtocolRequestContext(
  input: BuildProtocolRequestContextInput,
): BuildProtocolRequestContextResult {
  const rawExplicit = input.explicit ?? {}
  const effectiveExplicit = {
    ...rawExplicit,
    ...(rawExplicit.numImages == null && rawExplicit.n == null && input.defaultNumImages != null
      ? { numImages: input.defaultNumImages }
      : {}),
  }

  // 命中契约 → 走 contract-driven 分支：结果为最终字段 + promptAppends + rejected。
  // 缺失契约 →
  //  - 未提供 contractId → 兼容 legacy 分支（PROTOCOL_PARAMS 补全，用于旧调用位点/向导 UI）。
  //  - 显式提供的 contractId 未在注册表命中 → fail-closed（禁止回退到粗粒度协议默认）。
  const contract = input.contractId ? getContractById(input.contractId) : undefined
  if (input.contractId && !contract) {
    const rejected = [{
      key: 'contractId',
      value: input.contractId,
      reason: '注册表未收录该 contract id；不得回退协议默认',
    }]
    const requestContext: ImageRequestContext = { numImages: input.defaultNumImages ?? 1 }
    if (input.supplier) requestContext.supplier = input.supplier
    if (input.protocol) requestContext.provider = input.protocol as ProviderType
    if (input.routeId) requestContext.routeId = input.routeId
    if (input.operation) requestContext.operation = input.operation
    if (input.modelMapping?.modelId) {
      requestContext.modelId = input.modelMapping.modelId
      if (input.modelMapping.suffix) requestContext.modelSuffix = input.modelMapping.suffix
    }
    requestContext.rejectedParams = [...rejected]
    return {
      requestContext,
      promptAdditions: [],
      numImages: input.defaultNumImages ?? 1,
      known: false,
      rejectedParams: rejected,
    }
  }
  if (contract) {
    const resolved = resolveContractParams(contract, effectiveExplicit, {
      defaultNumImages: input.defaultNumImages ?? 1,
      ...(input.existingPrompt !== undefined ? { existingPrompt: input.existingPrompt } : {}),
    })
    const requestContext: ImageRequestContext = { numImages: resolved.numImages }
    if (input.supplier) requestContext.supplier = input.supplier
    if (input.protocol) requestContext.provider = input.protocol as ProviderType
    if (input.routeId) requestContext.routeId = input.routeId
    if (input.contractId) requestContext.contractId = input.contractId
    if (input.operation) requestContext.operation = input.operation
    if (input.modelMapping?.modelId) {
      requestContext.modelId = input.modelMapping.modelId
      if (input.modelMapping.suffix) requestContext.modelSuffix = input.modelMapping.suffix
    }
    if (resolved.aspectRatio) requestContext.aspectRatio = resolved.aspectRatio as ImageRequestContext['aspectRatio']
    if (resolved.resolution) requestContext.resolution = resolved.resolution as ImageRequestContext['resolution']
    if (resolved.promptAppends.length > 0) requestContext.promptAppends = [...resolved.promptAppends]
    if (Object.keys(resolved.fields).length > 0) requestContext.contractFields = { ...resolved.fields }
    if (resolved.rejected.length > 0) requestContext.rejectedParams = [...resolved.rejected]

    return {
      requestContext,
      promptAdditions: resolved.promptAppends,
      numImages: resolved.numImages,
      known: true,
      rejectedParams: resolved.rejected,
    }
  }

  const resolved = resolveProtocolParams(input.protocol, effectiveExplicit, {
    defaultNumImages: input.defaultNumImages ?? 1,
    ...(input.existingPrompt !== undefined ? { existingPromptAppends: input.existingPrompt } : {}),
  })

  const requestContext: ImageRequestContext = { numImages: resolved.numImages }
  if (input.supplier) requestContext.supplier = input.supplier
  if (input.protocol) requestContext.provider = input.protocol as ProviderType
  if (input.routeId) requestContext.routeId = input.routeId
  if (input.operation) requestContext.operation = input.operation
  if (input.modelMapping?.modelId) {
    requestContext.modelId = input.modelMapping.modelId
    if (input.modelMapping.suffix) requestContext.modelSuffix = input.modelMapping.suffix
  }
  if (resolved.aspectRatio) requestContext.aspectRatio = resolved.aspectRatio as ImageRequestContext['aspectRatio']
  if (resolved.resolution) requestContext.resolution = resolved.resolution as ImageRequestContext['resolution']
  if (resolved.promptAdditions.length > 0) requestContext.promptAppends = [...resolved.promptAdditions]

  return {
    requestContext,
    promptAdditions: resolved.promptAdditions,
    numImages: resolved.numImages,
    known: resolved.known,
  }
}

/**
 * MJ 后缀 flag → 同类别别名。resolver 早期去重只看解析器输入的 existingPromptAppends，
 * 而普通命令 / style 快捷命令的最终 prompt 在此层才拼装，因此这里必须做兜底去重：
 * 逐条 append 按 flag 归入类别，只有类别未在 base prompt / 已保留 append 中出现时才追加。
 *
 * 单类别可包含多个别名（如 stylize 与 s），任一别名已存在即视为同类别已占位。
 */
const APPEND_FLAG_CATEGORIES: Array<{ flags: string[] }> = [
  { flags: ['--ar'] },
  { flags: ['--stylize', '--s'] },
]

function detectAppendCategory(append: string): string[] | undefined {
  const match = append.trim().match(/^(--[A-Za-z][\w-]*)/)
  if (!match) return undefined
  const flag = match[1]!.toLowerCase()
  return APPEND_FLAG_CATEGORIES.find((cat) => cat.flags.includes(flag))?.flags
}

function existsInText(text: string, flags: string[]): boolean {
  if (!text) return false
  for (const flag of flags) {
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`, 'i').test(text)) return true
  }
  return false
}

/**
 * 拼接 prompt 与协议后缀。空 prompt 也能安全返回。
 *
 * 幂等保证：若 base prompt 已含 `--ar` / `--stylize` / `--s` 等同类别 flag，
 * 相同类别的 append 会被丢弃；两个类别互不影响；对同一输入重复调用结果不变。
 */
export function applyPromptAppends(prompt: string | undefined | null, appends?: string[]): string {
  const base = typeof prompt === 'string' ? prompt : ''
  if (!appends?.length) return base

  const trimmedBase = base.trim()
  const kept: string[] = []

  for (const rawAppend of appends) {
    const trimmedAppend = rawAppend.trim()
    if (!trimmedAppend) continue

    const category = detectAppendCategory(trimmedAppend)
    if (category) {
      if (existsInText(base, category)) continue
      if (existsInText(kept.join(' '), category)) continue
    }
    kept.push(trimmedAppend)
  }

  const suffix = kept.join(' ')
  if (!trimmedBase) return suffix
  if (!suffix) return base
  return `${base}${base.endsWith(' ') ? '' : ' '}${suffix}`
}
