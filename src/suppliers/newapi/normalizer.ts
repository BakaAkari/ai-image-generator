/**
 * 将 NewApiRawSnapshot 转为规范化的 CatalogSnapshot。
 */

import type { CatalogModel, CatalogSnapshot, CatalogNormalizer } from '../../catalog/model-catalog.js'
import type { CatalogModelPricing } from '../../catalog/model-catalog.js'
import type { NewApiModelItem, NewApiPricingItem, NewApiRawSnapshot } from './raw-types.js'
import { resolveNewApiCapabilities } from './capability.js'
import type { EndpointAliasMap } from './routes.js'
import { resolveNewApiRoutes } from './routes.js'

export const NEWAPI_PARSER_VERSION = '1.0.0'

function normalizePricing(item: NewApiModelItem, pricing?: NewApiPricingItem): CatalogModelPricing {
  if (pricing) {
    const type: CatalogModelPricing['type'] =
      pricing.quota_type === 0 ? 'per-token' : pricing.quota_type === 1 ? 'per-call' : 'unknown'
    const official: Record<string, number> = {}
    if (pricing.official_price && typeof pricing.official_price === 'string') {
      try {
        const parsed = JSON.parse(pricing.official_price)
        if (typeof parsed.input === 'number') official.input = parsed.input
        if (typeof parsed.output === 'number') official.output = parsed.output
      } catch { /* ignore malformed */ }
    }
    return {
      type,
      pricePerCall: type === 'per-call' && typeof pricing.model_price === 'number' ? pricing.model_price : undefined,
      tokenRatio: type === 'per-token' && typeof pricing.model_ratio === 'number' ? pricing.model_ratio : undefined,
      officialPriceInput: type === 'per-token' && official.input ? official.input : undefined,
      officialPriceOutput: type === 'per-token' && official.output ? official.output : undefined,
      completionRatio: type === 'per-token' && typeof pricing.completion_ratio === 'number' ? pricing.completion_ratio : undefined,
      enableGroups: Array.isArray(pricing.enable_groups) ? pricing.enable_groups : undefined,
      source: 'remote-pricing',
    }
  }
  return { type: 'unknown', source: 'remote-models' }
}

function normalizeModel(item: NewApiModelItem, pricing?: NewApiPricingItem, aliases?: EndpointAliasMap): CatalogModel {
  const { capabilities, reasons } = resolveNewApiCapabilities(item, aliases)
  // 语义规则引擎（v2.3）：端点语义识别直接产出路由（协议+能力由规则决定）。
  // 不再叠加 capability 推导：推导会把协议写死 openai，导致 mj/gemini 模型
  // 产生伪 openai 路由。空端点模型 fail-closed（如已弃用的 dall-e-3）。
  const routes = resolveNewApiRoutes(item.supported_endpoint_types ?? [], aliases)
  const hasBlockingReason = reasons.some(r =>
    r.includes('not image')
    || r.includes('no recognized')
    || r.includes('recognition-only')
    || r.includes('unsupported MJ/Kling')
    || r.includes('upload endpoint')
    || r.includes('video')
    || r.includes('image template'),
  )
  const executable = item.available !== false && routes.length > 0 && !hasBlockingReason
  const executableStatus: CatalogModel['executableStatus'] = executable ? 'available' : 'unsupported'

  return {
    id: item.id,
    modelType: item.model_type,
    description: item.description,
    capabilities: [...new Set(capabilities)],
    routes,
    pricing: normalizePricing(item, pricing),
    executable,
    executableStatus,
    unsupportedReasons: executable ? undefined : reasons,
  }
}

export class NewApiCatalogNormalizer implements CatalogNormalizer<NewApiRawSnapshot> {
  normalize(raw: NewApiRawSnapshot, aliases?: EndpointAliasMap): CatalogSnapshot {
    const modelsPayload = raw.endpoints.models.success ? raw.endpoints.models.data : undefined
    const pricingPayload = raw.endpoints.pricing.success ? raw.endpoints.pricing.data : undefined

    const pricingMap = new Map<string, NewApiPricingItem>()
    if (pricingPayload?.data) {
      for (const p of pricingPayload.data) {
        const id = p.model_name?.trim().toLowerCase()
        if (id) pricingMap.set(id, p)
      }
    }

    const rawModels = modelsPayload?.data ?? []
    const allModels: CatalogModel[] = []

    for (const item of rawModels) {
      const pricing = pricingMap.get(item.id.toLowerCase())
      allModels.push(normalizeModel(item, pricing, aliases))
    }

    allModels.sort((a, b) => a.id.localeCompare(b.id))

    const models = allModels.filter(m => m.executable)
    const error = raw.endpoints.models.success && raw.endpoints.pricing.success
      ? undefined
      : 'partial snapshot failure'

    return {
      supplier: 'newapi',
      schemaVersion: 1,
      parserVersion: NEWAPI_PARSER_VERSION,
      keyScopeFingerprint: raw.keyScopeFingerprint,
      models,
      allModels,
      fetchedAt: raw.fetchedAt,
      error,
    }
  }

  executable(snapshot: CatalogSnapshot): CatalogModel[] {
    return snapshot.allModels.filter(m => m.executable)
  }

  unsupported(snapshot: CatalogSnapshot): CatalogModel[] {
    return snapshot.allModels.filter(m => !m.executable)
  }
}

export function normalizeNewApiSnapshot(raw: NewApiRawSnapshot, aliases?: EndpointAliasMap): CatalogSnapshot {
  return new NewApiCatalogNormalizer().normalize(raw, aliases)
}
