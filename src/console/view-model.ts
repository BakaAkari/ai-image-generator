import type { Config } from '../shared/config.js'
import type { BillingInfo } from '../catalog/billing-info.js'
import type { ModelMappingConfig } from '../shared/types.js'

interface CatalogModelInput {
  id: string
  modes?: string[]
  routes?: Array<{ id: string; protocol: string; capability: string; endpointName?: string }>
  pricing?: { type: string; pricePerCall?: number; tokenRatio?: number }
  source?: string
  unsupportedReasons?: string[]
}

interface CatalogInput {
  supplier: string
  fetchedAt: number
  error?: string
  models: CatalogModelInput[]
  unsupportedModels?: CatalogModelInput[]
}

export interface ConsoleCatalogRow extends CatalogModelInput {
  selectable: boolean
  catalogPrice: { type: string; label: string; source: string }
  costQuote: {
    kind: 'catalog-quote' | 'unknown'
    chargeable: boolean
    amountUsdPerImage?: number
    creditsPerImage?: number
    label: string
  }
  chargePolicy: { type: string; label: string; source: string }
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

export function buildConsoleState(config: Config, catalog: CatalogInput | null, billing: BillingInfo | null): ImageGeneratorConsoleState {
  const mappings = new Map((config.modelMappings ?? []).map(mapping => [mapping.modelId, mapping]))
  const models = catalog?.models.map(model => buildRow(model, mappings.get(model.id), config, true)) ?? []
  const unsupportedModels = catalog?.unsupportedModels?.map(model => buildRow(model, mappings.get(model.id), config, false)) ?? []
  return {
    config,
    suppliers: [
      { id: 'yunwu', label: '云雾 yunwu.ai', status: 'maintained' },
      { id: 'gptgod', label: 'GPTGod（暂未适配）', status: 'unsupported' },
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
    billing,
  }
}

function buildRow(model: CatalogModelInput, mapping: ModelMappingConfig | undefined, config: Config, selectable: boolean): ConsoleCatalogRow {
  const catalogPrice = formatCatalogPrice(model)
  const costQuote = quoteCost(model, config)
  const chargePolicy = formatChargePolicy(mapping)
  return { ...model, selectable, catalogPrice, costQuote, chargePolicy }
}

function formatCatalogPrice(model: CatalogModelInput) {
  const pricing = model.pricing
  if (pricing?.type === 'per-call' && typeof pricing.pricePerCall === 'number') {
    return { type: 'per-call', label: `$${pricing.pricePerCall.toFixed(4)}/次`, source: model.source ?? 'remote-pricing' }
  }
  if (pricing?.type === 'per-token') {
    return { type: 'per-token', label: `token 目录倍率 ×${pricing.tokenRatio ?? '?'}`, source: model.source ?? 'remote-pricing' }
  }
  return { type: 'unknown', label: '目录价格未知', source: model.source ?? 'unknown' }
}

function quoteCost(model: CatalogModelInput, config: Config): ConsoleCatalogRow['costQuote'] {
  const pricing = model.pricing
  if (pricing?.type === 'per-call' && typeof pricing.pricePerCall === 'number') {
    const rate = config.creditExchangeRate
    const markup = config.costMarkup
    const credits = Number.isFinite(rate) && Number.isFinite(markup) && Number(rate) > 0 && Number(markup) > 0
      ? Math.round(pricing.pricePerCall * Number(rate) * Number(markup) * 100) / 100
      : undefined
    return {
      kind: 'catalog-quote',
      chargeable: credits !== undefined,
      amountUsdPerImage: pricing.pricePerCall,
      creditsPerImage: credits,
      label: credits === undefined ? '目录报价（未配置换算）' : `目录报价约 ${credits} 积分/张`,
    }
  }
  return { kind: 'unknown', chargeable: false, label: '无法计算每图成本' }
}

function formatChargePolicy(mapping: ModelMappingConfig | undefined): ConsoleCatalogRow['chargePolicy'] {
  const policy = mapping?.chargePolicy
  if (!policy) return { type: 'unconfigured', label: '未配置收费策略', source: 'configuration' }
  if (policy.type === 'fixed') return { type: 'fixed', label: `固定 ${policy.creditsPerImage} 积分/张`, source: 'operational-fixed' }
  if (policy.type === 'cost-plus') return { type: 'cost-plus', label: policy.acceptEstimated ? '目录成本加成（允许估算）' : '目录成本加成（拒绝估算）', source: 'configuration' }
  return { type: 'disabled', label: `禁用：${policy.reason}`, source: 'configuration' }
}
