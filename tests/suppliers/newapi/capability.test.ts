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
  test('MJ imagine endpoint is recognized by semantic rule even without alias', () => {
    const item = makeModel()
    const { capabilities, reasons } = resolveNewApiCapabilities(item)
    expect(capabilities).toContain('text-to-image')
    expect(reasons.some(r => r.includes('mj imagine'))).toBe(true)
  })

  test('alias can override semantic rule (explicit user declaration wins)', () => {
    // 用户把 MJ imagine 显式覆盖为 openai 协议（异常但允许）
    const aliases: EndpointAliasMap = {
      'MJ imagine': { protocol: 'openai', capability: 'image-edit' },
    }
    const item = makeModel()
    const { capabilities, reasons } = resolveNewApiCapabilities(item, aliases)
    expect(capabilities).toContain('image-edit')
    expect(reasons.some(r => r.includes('alias'))).toBe(true)
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
