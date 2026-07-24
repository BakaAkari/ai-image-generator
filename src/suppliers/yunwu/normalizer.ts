/**
 * 将 YunwuRawSnapshot 转为规范化的 CatalogSnapshot。
 */

import type { CatalogModel, CatalogSnapshot, CatalogNormalizer } from '../../catalog/model-catalog.js'
import type { CatalogModelPricing } from '../../catalog/model-catalog.js'
import type { YunwuModelItem, YunwuPricingItem, YunwuRawSnapshot } from './raw-types.js'
import { resolveYunwuCapabilities } from './capability.js'
import { resolveRoutesFromCapabilities, resolveYunwuRoutes } from './routes.js'

export const YUNWU_PARSER_VERSION = '1.0.0'

function normalizePricing(item: YunwuModelItem, pricing?: YunwuPricingItem): CatalogModelPricing {
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

function normalizeModel(item: YunwuModelItem, pricing?: YunwuPricingItem): CatalogModel {
  const { capabilities, reasons } = resolveYunwuCapabilities(item)
  const routesFromEndpoints = resolveYunwuRoutes(item.supported_endpoint_types ?? [])
  const routesFromCapabilities = routesFromEndpoints.length > 0 ? [] : resolveRoutesFromCapabilities(capabilities)
  const routes = [...routesFromEndpoints, ...routesFromCapabilities]
  const hasBlockingReason = reasons.some(r => r.includes('not image') || r.includes('no recognized'))
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

export class YunwuCatalogNormalizer implements CatalogNormalizer<YunwuRawSnapshot> {
  normalize(raw: YunwuRawSnapshot): CatalogSnapshot {
    const modelsPayload = raw.endpoints.models.success ? raw.endpoints.models.data : undefined
    const pricingPayload = raw.endpoints.pricing.success ? raw.endpoints.pricing.data : undefined

    const pricingMap = new Map<string, YunwuPricingItem>()
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
      allModels.push(normalizeModel(item, pricing))
    }

    allModels.sort((a, b) => a.id.localeCompare(b.id))

    const models = allModels.filter(m => m.executable)
    const error = raw.endpoints.models.success && raw.endpoints.pricing.success
      ? undefined
      : 'partial snapshot failure'

    return {
      supplier: 'yunwu',
      schemaVersion: 1,
      parserVersion: YUNWU_PARSER_VERSION,
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

export function normalizeYunwuSnapshot(raw: YunwuRawSnapshot): CatalogSnapshot {
  return new YunwuCatalogNormalizer().normalize(raw)
}
