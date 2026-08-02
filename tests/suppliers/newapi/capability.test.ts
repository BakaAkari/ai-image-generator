import { describe, expect, test } from 'vitest'

import { resolveNewApiCapabilities } from '../../../src/suppliers/newapi/capability.js'
import type { EndpointAliasMap } from '../../../src/suppliers/newapi/routes.js'

function makeModel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mj_imagine',
    model_type: '图像',
    description: 'Midjourney imagine mode.',
    supported_endpoint_types: ['MJ imagine'],
    available: true,
    ...overrides,
  }
}

describe('resolveNewApiCapabilities with aliases', () => {
  test('MJ imagine alias makes openlux MJ model executable (case-insensitive)', () => {
    const aliases: EndpointAliasMap = {
      'MJ imagine': { protocol: 'mj', capability: 'text-to-image' },
    }
    const item = makeModel()
    const { capabilities, reasons } = resolveNewApiCapabilities(item, aliases)
    expect(capabilities).toContain('text-to-image')
    expect(reasons.some(r => r.includes('mj/kling'))).toBe(true)
  })

  test('without alias, unknown english endpoint stays unsupported', () => {
    const item = makeModel()
    const { capabilities, reasons } = resolveNewApiCapabilities(item)
    expect(capabilities).toEqual([])
    expect(reasons.some(r => r.includes('no recognized'))).toBe(true)
  })

  test('openai alias endpoint resolves text-to-image capability', () => {
    const aliases: EndpointAliasMap = {
      'openai-draw': { protocol: 'openai', capability: 'text-to-image' },
    }
    const item = makeModel({ supported_endpoint_types: ['openai-draw'] })
    const { capabilities } = resolveNewApiCapabilities(item, aliases)
    expect(capabilities).toContain('text-to-image')
  })
})
