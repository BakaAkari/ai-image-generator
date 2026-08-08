/**
 * config-autopilot：自动模式下的配置推导服务（2.6.0）。
 *
 * 一致性原则（设计 v2 对抗评审后的约束）：
 * - 推导读 catalog.current 快照，与结算同源同实例（不直接探测 /api/pricing）。
 * - 只补缺：已有映射（含 billingPolicy / tokenRatio / ratioOverride 等特殊字段）绝不重复生成、不修改任何字段。
 * - 零换算：本服务只产出「定价事实」（price / group_ratio 上界 / quota），
 *   美元→积分的换算永远由 shared/billing.ts 的既有函数完成。
 * - suffix 稳定派生：按 modelId 排序后取稳定段，不依赖 API 返回顺序；与手动 suffix 冲突时手动优先。
 * - 覆盖层以 modelId 为唯一 key，合并双向不互相覆盖（幂等）。
 */

import type { CatalogSnapshot } from '../catalog/types.js'
import type { ModelMappingConfig } from '../shared/types.js'

/** 自动模式下预置的精选模型 id（缺省补齐用；用户已用模型优先于本表）。 */
export const DEFAULT_COMMON_MODEL_IDS = [
  'gpt-image-2',
  'gemini-3-pro-image',
  'qwen-image-max-2025-12-30',
  'grok-imagine-image',
  'mj_imagine',
] as const

/** 单模型定价参考（只读展示，分口径）。 */
export interface PricingReference {
  modelId: string
  pricePerCall: number | null
  /** enableGroups 上界倍率（预扣口径）。 */
  upperBoundRatio: number | null
  /** 结算实际口径说明（响应头/日志真源优先，公式链兜底）。 */
  settlementNote: string
}

export interface AutoDerivedConfig {
  /** 建议新增的映射（仅缺失项；已有映射不在此列）。 */
  suggestedMappings: ModelMappingConfig[]
  /** 定价参考（只读展示，分口径标签）。 */
  pricingReferences: PricingReference[]
  derivedAt: number
  /** 推导失败/降级信息（供面板黄条展示）。 */
  warnings: string[]
}

export interface DeriveOptions {
  /** 用户已用过的模型 id 集（来自 UserManager 统计，可空）。 */
  usedModelIds?: string[]
}

/** 从 modelId 派生稳定 suffix：取 vendor 段 + 短版本尾缀，按 modelId 排序保证幂等。 */
export function deriveStableSuffix(modelId: string, existingSuffixes: Set<string>): string {
  const base = baseSuffixOf(modelId)
  let candidate = base
  let i = 2
  while (existingSuffixes.has(candidate)) {
    candidate = `${base}${i}`
    i += 1
  }
  return candidate
}

function baseSuffixOf(modelId: string): string {
  const lower = modelId.toLowerCase()
  if (lower.includes('gpt-image')) return 'gpt'
  if (lower.includes('gemini')) return 'gemini'
  if (lower.includes('qwen')) return 'qwen'
  if (lower.includes('grok')) return 'grok'
  if (lower.startsWith('mj')) return 'mj'
  if (lower.includes('doubao') || lower.includes('seedream')) return 'doubao'
  if (lower.includes('flux')) return 'flux'
  // 兜底：首段（如 vendor 名），去版本号
  const first = lower.split(/[-_.\s]/)[0] || 'model'
  return first.slice(0, 8) || 'model'
}

/**
 * 从 catalog 快照推导建议配置。
 * - 只补缺：existing 中已存在的 modelId 不生成、不修改。
 * - 入选范围：usedModelIds + DEFAULT_COMMON_MODEL_IDS 中 catalog 实际可用的模型。
 * - 全量可用模型不自动入选（避免过度配置，设计缺陷 4 修正）。
 */
export function deriveConfigFromSnapshot(
  snapshot: CatalogSnapshot,
  existingMappings: ModelMappingConfig[],
  options: DeriveOptions = {},
): AutoDerivedConfig {
  const warnings: string[] = []
  const derivedAt = Date.now()

  const existingIds = new Set(existingMappings.map((m) => m.modelId))
  const existingSuffixes = new Set(existingMappings.map((m) => m.suffix))
  const availableById = new Map<string, CatalogSnapshot['models'][number]>()

  for (const model of snapshot.models) {
    availableById.set(model.id, model)
  }

  if (snapshot.error) warnings.push(`目录快照带错误信息：${snapshot.error}`)
  if (snapshot.models.length === 0) warnings.push('目录快照为空，无法推导（沿用当前配置）')

  // 候选集：用户已用 + 预置精选，按 modelId 稳定排序
  const wanted = new Set<string>([...(options.usedModelIds ?? []), ...DEFAULT_COMMON_MODEL_IDS])
  const candidates = [...wanted]
    .filter((id) => availableById.has(id) && !existingIds.has(id))
    .sort()

  const suggestedMappings: ModelMappingConfig[] = candidates.map((id) => ({
    suffix: deriveStableSuffix(id, existingSuffixes),
    modelId: id,
    restricted: false,
  }))

  // 定价参考：只读展示，分口径；零换算（换算归 billing.ts）
  const pricingReferences: PricingReference[] = [...availableById.values()]
    .filter((m) => existingIds.has(m.id) || wanted.has(m.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((model) => {
      const pricing = model.pricing
      const groups = pricing.enableGroups ?? []
      const ratios = groups
        .map((g) => snapshot.groupRatio?.[g])
        .filter((r): r is number => typeof r === 'number' && Number.isFinite(r) && r >= 0)
      const upperBoundRatio = ratios.length > 0 ? Math.max(...ratios) : null
      const price = pricing.type === 'per-call' ? pricing.pricePerCall ?? null : null
      return {
        modelId: model.id,
        pricePerCall: price,
        upperBoundRatio,
        settlementNote:
          '结算优先使用响应头 x-routing-group 命中倍率，其次日志真源（需配置 logAccessApiKey），公式链（pricePerCall × 实际倍率）兜底。',
      }
    })

  return { suggestedMappings, pricingReferences, derivedAt, warnings }
}

/**
 * 合并推导建议到现有映射（幂等）。
 * - 现有映射恒优先（含特殊字段，绝不覆盖）。
 * - 只追加缺失 modelId。
 * - 同一输入两次合并结果相同（推导只补缺，无状态）。
 */
export function mergeDerivedMappings(
  existing: ModelMappingConfig[],
  suggested: ModelMappingConfig[],
): ModelMappingConfig[] {
  const existingIds = new Set(existing.map((m) => m.modelId))
  const additions = suggested.filter((s) => !existingIds.has(s.modelId))
  return [...existing, ...additions]
}
