import { describe, expect, test } from 'vitest'
import { resolveConfiguredModelRoute, MissingModelMappingError, MissingCatalogRouteError } from '../../src/service/model-route-selection.js'

describe('resolveConfiguredModelRoute', () => {
  test('empty mappings fail explicitly instead of selecting a concrete default model', () => {
    expect(() => resolveConfiguredModelRoute([], undefined)).toThrow(MissingModelMappingError)
  })

  test('model name containing gemini does not determine protocol', () => {
    const route = resolveConfiguredModelRoute(
      [{ suffix: 'x', modelId: 'gemini-looking-name' }],
      () => ({ routeId: 'openai:text-to-image', protocol: 'openai' }),
    )
    expect(route.protocol).toBe('openai')
  })

  test('model name without gemini can use a gemini catalog route', () => {
    const route = resolveConfiguredModelRoute(
      [{ suffix: 'x', modelId: 'neutral-name' }],
      () => ({ routeId: 'gemini:text-to-image', protocol: 'gemini' }),
    )
    expect(route.protocol).toBe('gemini')
  })

  test('missing catalog route fails closed', () => {
    expect(() => resolveConfiguredModelRoute(
      [{ suffix: 'x', modelId: 'some-model' }],
      () => undefined,
    )).toThrow(MissingCatalogRouteError)
  })
})
