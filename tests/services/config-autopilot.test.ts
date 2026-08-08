import { describe, expect, test } from 'vitest'

import {
  deriveConfigFromSnapshot,
  deriveStableSuffix,
  mergeDerivedMappings,
} from '../../src/services/config-autopilot.js'
import type { CatalogSnapshot } from '../../src/catalog/types.js'
import type { ModelMappingConfig } from '../../src/shared/types.js'

function makeSnapshot(overrides: Partial<CatalogSnapshot> = {}): CatalogSnapshot {
  return {
    supplier: 'newapi',
    models: [
      {
        id: 'gpt-image-2',
        routes: [{ id: 'r', protocol: 'openai', capability: 'text-to-image' }],
        modes: ['text-to-image'],
        pricing: { type: 'per-call', pricePerCall: 0.03, enableGroups: ['Openai-Gpt-1'] },
        source: 'remote-pricing',
      },
      {
        id: 'gemini-3-pro-image',
        routes: [{ id: 'r', protocol: 'gemini', capability: 'text-to-image' }],
        modes: ['text-to-image'],
        pricing: {
          type: 'per-call',
          pricePerCall: 0.33,
          enableGroups: ['Aistudio-Gemini-2', 'Aistudio-Gemini-4', 'Vertex-Gemini-1'],
        },
        source: 'remote-pricing',
      },
      {
        id: 'qwen-image-max-2025-12-30',
        routes: [{ id: 'r', protocol: 'openai', capability: 'text-to-image' }],
        modes: ['text-to-image'],
        pricing: { type: 'per-call', pricePerCall: 0.5, enableGroups: ['Alibaba-2', 'Alibaba-3'] },
        source: 'remote-pricing',
      },
      {
        id: 'doubao-seedream-4-0-250828',
        routes: [{ id: 'r', protocol: 'openai', capability: 'text-to-image' }],
        modes: ['text-to-image'],
        pricing: { type: 'per-call', pricePerCall: 0.2, enableGroups: ['Alibaba-2'] },
        source: 'remote-pricing',
      },
    ],
    unsupportedModels: [],
    fetchedAt: Date.now(),
    groupRatio: {
      'Openai-Gpt-1': 0.04412,
      'Aistudio-Gemini-2': 0.26471,
      'Aistudio-Gemini-4': 0.95589,
      'Vertex-Gemini-1': 0.80883,
      'Alibaba-2': 0.1103,
      'Alibaba-3': 0.22059,
    },
    ...overrides,
  }
}

describe('deriveStableSuffix', () => {
  test('returns vendor-based suffix independent of input order', () => {
    const used = new Set<string>()
    expect(deriveStableSuffix('gemini-3-pro-image', used)).toBe('gemini')
    expect(deriveStableSuffix('qwen-image-max-2025-12-30', used)).toBe('qwen')
    expect(deriveStableSuffix('gpt-image-2', used)).toBe('gpt')
  })

  test('appends numeric suffix when base collides', () => {
    const used = new Set(['qwen'])
    expect(deriveStableSuffix('qwen-image-max', used)).toBe('qwen2')
  })

  test('is deterministic: same model + same used set always same suffix', () => {
    const a = deriveStableSuffix('flux-1.1-pro', new Set())
    const b = deriveStableSuffix('flux-1.1-pro', new Set())
    expect(a).toBe(b)
  })
})

describe('deriveConfigFromSnapshot', () => {
  test('only suggests missing models, never duplicates existing', () => {
    const existing: ModelMappingConfig[] = [
      { suffix: 'gpt', modelId: 'gpt-image-2', restricted: false },
    ]
    const result = deriveConfigFromSnapshot(makeSnapshot(), existing)
    const suggestedIds = result.suggestedMappings.map((m) => m.modelId)
    expect(suggestedIds).not.toContain('gpt-image-2')
    // 预置精选 + used 里 catalog 可用的模型
    expect(suggestedIds).toContain('gemini-3-pro-image')
    expect(suggestedIds).toContain('qwen-image-max-2025-12-30')
    expect(result.warnings).toHaveLength(0)
  })

  test('never modifies existing mapping fields (mj billingPolicy preservation)', () => {
    const mj: ModelMappingConfig = {
      suffix: 'mj',
      modelId: 'mj_imagine',
      restricted: false,
      tokenRatio: 2.5,
      billingPolicy: { type: 'fixed', creditsPerImage: 0.1 },
    }
    const existing: ModelMappingConfig[] = [mj]
    const result = deriveConfigFromSnapshot(makeSnapshot(), existing)
    expect(result.suggestedMappings.some((m) => m.modelId === 'mj_imagine')).toBe(false)
    // existing 不变（mergeDerivedMappings 只追加）
    const merged = mergeDerivedMappings(existing, result.suggestedMappings)
    const mergedMj = merged.find((m) => m.modelId === 'mj_imagine')
    expect(mergedMj?.billingPolicy).toEqual({ type: 'fixed', creditsPerImage: 0.1 })
    expect(mergedMj?.tokenRatio).toBe(2.5)
  })

  test('upperBoundRatio = max of enableGroups group_ratio (pre-authorization scope)', () => {
    const result = deriveConfigFromSnapshot(makeSnapshot(), [])
    const gemini = result.pricingReferences.find((r) => r.modelId === 'gemini-3-pro-image')
    expect(gemini?.pricePerCall).toBe(0.33)
    // Aistudio-Gemini-4 = 0.95589 是上界；不是结算倍率（结算走响应头/日志真源）
    expect(gemini?.upperBoundRatio).toBe(0.95589)
  })

  test('reports warning when snapshot is empty', () => {
    const empty = makeSnapshot({ models: [] })
    const result = deriveConfigFromSnapshot(empty, [])
    expect(result.suggestedMappings).toHaveLength(0)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  test('usedModelIds broaden the candidate set', () => {
    const existing: ModelMappingConfig[] = []
    const result = deriveConfigFromSnapshot(makeSnapshot(), existing, {
      usedModelIds: ['doubao-seedream-4-0-250828'],
    })
    expect(result.suggestedMappings.map((m) => m.modelId)).toContain('doubao-seedream-4-0-250828')
  })
})

describe('mergeDerivedMappings (idempotency)', () => {
  test('twice-merged equals once-merged', () => {
    const existing: ModelMappingConfig[] = [{ suffix: 'gpt', modelId: 'gpt-image-2', restricted: false }]
    const result = deriveConfigFromSnapshot(makeSnapshot(), existing)
    const once = mergeDerivedMappings(existing, result.suggestedMappings)
    const twice = mergeDerivedMappings(once, result.suggestedMappings)
    expect(twice).toEqual(once)
  })

  test('existing mappings always win, additions only for missing ids', () => {
    const existing: ModelMappingConfig[] = [{ suffix: 'mygpt', modelId: 'gpt-image-2', restricted: true }]
    const result = deriveConfigFromSnapshot(makeSnapshot(), existing)
    const merged = mergeDerivedMappings(existing, result.suggestedMappings)
    const gpt = merged.find((m) => m.modelId === 'gpt-image-2')
    expect(gpt?.suffix).toBe('mygpt')
    expect(gpt?.restricted).toBe(true)
  })
})
