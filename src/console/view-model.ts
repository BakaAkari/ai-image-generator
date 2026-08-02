import type { Config } from '../shared/config.js'
import type { ModelMappingConfig } from '../shared/types.js'
import type { BillingInfo } from '../catalog/billing-info.js'
import { SUPPLIER_CREDIT_TO_RMB as CATALOG_SUPPLIER_CREDIT_TO_RMB } from '../catalog/billing-info.js'

interface CatalogModelInput {
  id: string
  modes?: string[]
  routes?: Array<{ id: string; protocol: string; capability: string; endpointName?: string }>
  pricing?: { type: string; pricePerCall?: number; tokenRatio?: number; officialPriceInput?: number; officialPriceOutput?: number; completionRatio?: number }
  source?: string
  unsupportedReasons?: string[]
}

interface CatalogInput {
  supplier: string
  fetchedAt: number
  error?: string
  models: CatalogModelInput[]
  unsupportedModels?: CatalogModelInput[]
  groupRatio?: Record<string, number>
}

export interface ConsoleCatalogRow extends CatalogModelInput {
  selectable: boolean
  /**
   * 供应商目录报价折算后的人民币成本（× mapping.groupRatio × 0.5）。仅参考，
   * 运行时用户扣费依赖后生成定价（usage.total_tokens）。
   */
  yunwuCost: { type: string; label: string }
  groupRatio: number
}

export interface ImageGeneratorConsoleState {
  config: Config
  suppliers: Array<{ id: string; label: string; status: 'maintained' | 'unsupported' }>
  catalog: null | {
    supplier: string
    fetchedAt: number
    error?: string
    models: ConsoleCatalogRow[]
    selectableModels: ConsoleCatalogRow[]
    unsupportedModels: ConsoleCatalogRow[]
  }
  billing: BillingInfo | null
}

export function resolveMappingGroupRatio(mapping?: ModelMappingConfig): number {
  if (typeof mapping?.groupRatio === 'number' && Number.isFinite(mapping.groupRatio) && mapping.groupRatio > 0) {
    return mapping.groupRatio
  }
  return 1
}

export function resolvePricingParams(config: Config): { creditsPerCny: number | null; markupPercent: number | null } {
  const creditsPerCny = typeof config.creditsPerCny === 'number' && Number.isFinite(config.creditsPerCny) && config.creditsPerCny > 0
    ? config.creditsPerCny
    : null
  const markupPercent = typeof config.pricingMarkupPercent === 'number'
    && Number.isFinite(config.pricingMarkupPercent)
    && config.pricingMarkupPercent >= 0
    ? config.pricingMarkupPercent
    : null
  return { creditsPerCny, markupPercent }
}

export function buildConsoleState(
  config: Config,
  catalog: CatalogInput | null,
  _billing: BillingInfo | null,
  mappings?: ModelMappingConfig[],
): ImageGeneratorConsoleState {
  const mappingIndex = new Map<string, ModelMappingConfig>()
  for (const m of mappings ?? config.modelMappings ?? []) {
    if (!mappingIndex.has(m.modelId)) mappingIndex.set(m.modelId, m)
  }
  const models = catalog?.models.map(model => buildRow(model, true, mappingIndex.get(model.id))) ?? []
  const unsupportedModels = catalog?.unsupportedModels?.map(model => buildRow(model, false, mappingIndex.get(model.id))) ?? []
  return {
    config,
    suppliers: [
      { id: 'newapi', label: 'NewAPI 兼容（云雾 / GPTGod 等）', status: 'maintained' },
      { id: 'openai-official', label: 'OpenAI 官方（暂未适配）', status: 'unsupported' },
      { id: 'gemini-official', label: 'Gemini 官方（暂未适配）', status: 'unsupported' },
    ],
    catalog: catalog ? {
      supplier: catalog.supplier,
      fetchedAt: catalog.fetchedAt,
      error: catalog.error,
      models,
      selectableModels: models.filter(model => model.selectable),
      unsupportedModels,
    } : null,
    billing: _billing,
  }
}

function buildRow(
  model: CatalogModelInput,
  selectable: boolean,
  mapping?: ModelMappingConfig,
): ConsoleCatalogRow {
  const groupRatio = resolveMappingGroupRatio(mapping)
  const yunwuCost = formatYunwuCost(model, groupRatio)
  return { ...model, selectable, yunwuCost, groupRatio }
}

function formatYunwuCost(model: CatalogModelInput, groupRatio: number): ConsoleCatalogRow['yunwuCost'] {
  const pricing = model.pricing
  const ratio = Number.isFinite(groupRatio) && groupRatio > 0 ? groupRatio : 1
  if (pricing?.type === 'per-call' && typeof pricing.pricePerCall === 'number') {
    const effective = pricing.pricePerCall * ratio
    const rmb = Math.round(effective * CATALOG_SUPPLIER_CREDIT_TO_RMB * 100) / 100
    if (ratio !== 1) {
      return { type: 'per-call', label: `¥${rmb.toFixed(2)}/张（分组倍率 ×${ratio}）` }
    }
    return { type: 'per-call', label: `¥${rmb.toFixed(2)}/张` }
  }
  if (pricing?.type === 'per-token') {
    const outputPrice = pricing.officialPriceOutput ?? (typeof pricing.tokenRatio === 'number' ? pricing.tokenRatio * 5 : undefined)
    if (outputPrice) {
      const rmb = Math.round(outputPrice / 1_000_000 * CATALOG_SUPPLIER_CREDIT_TO_RMB * 100) / 100
      return { type: 'per-token', label: `≈¥${rmb.toFixed(2)}/1k tokens（按量）` }
    }
    return { type: 'per-token', label: `token ×${pricing.tokenRatio ?? '?'}（按量）` }
  }
  return { type: 'unknown', label: '未知' }
}
