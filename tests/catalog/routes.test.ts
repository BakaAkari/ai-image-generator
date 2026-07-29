import { describe, test, expect } from 'vitest'
import { resolveYunwuRoutes, resolveRoutesFromCapabilities } from '../../src/suppliers/yunwu/routes.js'
import type { GenerationRoute } from '../../src/catalog/model-catalog.js'

describe('resolveYunwuRoutes', () => {
  test('image-generation endpoint maps to openai text-to-image', () => {
    const routes = resolveYunwuRoutes(['image-generation'])
    expect(routes).toEqual<GenerationRoute[]>([
      { id: 'openai:text-to-image', protocol: 'openai', capability: 'text-to-image', endpointName: 'image-generation' },
    ])
  })

  test('openai edit endpoint maps to openai image-edit', () => {
    const routes = resolveYunwuRoutes(['openai-编辑'])
    expect(routes).toEqual<GenerationRoute[]>([
      { id: 'openai:image-edit', protocol: 'openai', capability: 'image-edit', endpointName: 'openai-编辑' },
    ])
  })

  test('gemini endpoint maps to explicit text-to-image and image-to-image routes', () => {
    const routes = resolveYunwuRoutes(['gemini'])
    expect(routes).toEqual<GenerationRoute[]>([
      { id: 'gemini:text-to-image', protocol: 'gemini', capability: 'text-to-image', endpointName: 'gemini' },
      { id: 'gemini:image-to-image', protocol: 'gemini', capability: 'image-to-image', endpointName: 'gemini' },
    ])
  })

  test('dall-e-3 endpoint maps to openai text-to-image', () => {
    const routes = resolveYunwuRoutes(['dall-e-3'])
    expect(routes).toEqual<GenerationRoute[]>([
      { id: 'openai:text-to-image', protocol: 'openai', capability: 'text-to-image', endpointName: 'dall-e-3' },
    ])
  })

  test('unknown endpoint yields no route', () => {
    const routes = resolveYunwuRoutes(['数字人'])
    expect(routes).toEqual([])
  })

  test('mixed endpoints drop unknowns and keep all known capability routes', () => {
    const routes = resolveYunwuRoutes(['image-generation', '图像识别', 'gemini'])
    expect(routes.map(r => r.id)).toEqual([
      'openai:text-to-image',
      'gemini:text-to-image',
      'gemini:image-to-image',
    ])
  })
})

describe('resolveRoutesFromCapabilities', () => {
  test('maps known capabilities to default routes', () => {
    const routes = resolveRoutesFromCapabilities(['text-to-image', 'image-edit'])
    expect(routes.map(r => r.id)).toEqual(['openai:text-to-image', 'openai:image-edit'])
  })

  test('returns empty for empty capabilities', () => {
    const routes = resolveRoutesFromCapabilities([])
    expect(routes).toEqual([])
  })
})
