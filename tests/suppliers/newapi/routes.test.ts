import { describe, test, expect } from 'vitest'
import { resolveNewApiRoutes, normalizeEndpoint } from '../../../src/suppliers/newapi/routes.js'
import type { EndpointAliasMap } from '../../../src/suppliers/newapi/routes.js'

describe('resolveNewApiRoutes', () => {
  test('default table maps mj想象模式 to mj:text-to-image', () => {
    const routes = resolveNewApiRoutes(['mj想象模式'])
    expect(routes).toEqual([
      { id: 'mj:text-to-image', protocol: 'mj', capability: 'text-to-image', endpointName: 'mj想象模式' },
    ])
  })

  test('alias maps MJ imagine to mj:text-to-image', () => {
    const aliases: EndpointAliasMap = {
      'MJ imagine': { protocol: 'mj', capability: 'text-to-image' },
    }
    const routes = resolveNewApiRoutes(['MJ imagine'], aliases)
    expect(routes).toEqual([
      { id: 'mj:text-to-image', protocol: 'mj', capability: 'text-to-image', endpointName: 'MJ imagine' },
    ])
  })

  test('unknown endpoint without alias returns empty routes', () => {
    const routes = resolveNewApiRoutes(['unknown-future-endpoint'])
    expect(routes).toEqual([])
  })

  test('alias and default table are deduplicated', () => {
    const aliases: EndpointAliasMap = {
      'openai-draw': { protocol: 'openai', capability: 'text-to-image' },
      'mj想象模式': { protocol: 'mj', capability: 'text-to-image' },
    }
    const routes = resolveNewApiRoutes(['openai-draw', 'mj想象模式', 'openai-绘图'], aliases)
    expect(routes).toEqual([
      { id: 'openai:text-to-image', protocol: 'openai', capability: 'text-to-image', endpointName: 'openai-draw' },
      { id: 'mj:text-to-image', protocol: 'mj', capability: 'text-to-image', endpointName: 'mj想象模式' },
    ])
  })

  test('alias lookup is case-insensitive by normalized endpoint', () => {
    const aliases: EndpointAliasMap = {
      'gemini-gen': { protocol: 'gemini', capability: 'text-to-image' },
    }
    const routes = resolveNewApiRoutes(['  GEMINI-GEN  '], aliases)
    expect(routes).toEqual([
      { id: 'gemini:text-to-image', protocol: 'gemini', capability: 'text-to-image', endpointName: '  GEMINI-GEN  ' },
    ])
  })
})

describe('normalizeEndpoint', () => {
  test('trims and lowercases endpoint names', () => {
    expect(normalizeEndpoint('  MJ想象模式  ')).toBe('mj想象模式')
    expect(normalizeEndpoint('OpenAI-Draw')).toBe('openai-draw')
  })
})
