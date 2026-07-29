import { describe, expect, test } from 'vitest'
import {
  resolveConfiguredModelRoute,
  MissingModelMappingError,
  MissingCatalogRouteError,
  selectRouteForOperation,
} from '../../src/service/model-route-selection.js'

describe('resolveConfiguredModelRoute', () => {
  test('empty mappings fail explicitly instead of selecting a concrete default model', () => {
    expect(() => resolveConfiguredModelRoute([], undefined)).toThrow(MissingModelMappingError)
  })

  test('model name containing gemini does not determine protocol', () => {
    const route = resolveConfiguredModelRoute(
      [{ suffix: 'x', modelId: 'gemini-looking-name' }],
      () => ({ routeId: 'openai:text-to-image', protocol: 'openai', operation: 'text-to-image' }),
    )
    expect(route.protocol).toBe('openai')
  })

  test('model name without gemini can use a gemini catalog route', () => {
    const route = resolveConfiguredModelRoute(
      [{ suffix: 'x', modelId: 'neutral-name' }],
      () => ({ routeId: 'gemini:text-to-image', protocol: 'gemini', operation: 'text-to-image' }),
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

describe('selectRouteForOperation', () => {
  test('text-to-image → picks text-to-image route', () => {
    const result = selectRouteForOperation(
      { id: 'm', routes: [{ id: 'r1', protocol: 'openai', capability: 'text-to-image' }] },
      'text-to-image',
    )
    expect(result?.routeId).toBe('r1')
    expect(result?.protocol).toBe('openai')
  })

  test('image-edit → prefers image-edit route over text-to-image', () => {
    const result = selectRouteForOperation(
      {
        id: 'm',
        routes: [
          { id: 'r1', protocol: 'openai', capability: 'text-to-image' },
          { id: 'r2', protocol: 'openai', capability: 'image-edit' },
        ],
      },
      'image-edit',
    )
    expect(result?.routeId).toBe('r2')
  })

  test('MJ image-edit without dedicated route falls back to Imagine text-to-image', () => {
    const result = selectRouteForOperation(
      { id: 'mj_imagine', routes: [{ id: 'mj:imagine', protocol: 'mj', capability: 'text-to-image' }] },
      'image-edit',
    )
    expect(result?.routeId).toBe('mj:imagine')
    expect(result?.protocol).toBe('mj')
  })

  test('OpenAI image-edit without dedicated route does NOT fall back to text-to-image', () => {
    const result = selectRouteForOperation(
      { id: 'gpt-image-2', routes: [{ id: 'openai:t2i', protocol: 'openai', capability: 'text-to-image' }] },
      'image-edit',
    )
    expect(result).toBeUndefined()
  })

  test('Gemini image-edit without dedicated route does NOT fall back to text-to-image', () => {
    const result = selectRouteForOperation(
      { id: 'gemini-2.5', routes: [{ id: 'gemini:t2i', protocol: 'gemini', capability: 'text-to-image' }] },
      'image-edit',
    )
    expect(result).toBeUndefined()
  })

  test('Gemini image-to-image capability is selected explicitly for image-edit', () => {
    const result = selectRouteForOperation(
      {
        id: 'gemini-3-pro-image-preview',
        routes: [
          { id: 'gemini:text-to-image', protocol: 'gemini', capability: 'text-to-image' },
          { id: 'gemini:image-to-image', protocol: 'gemini', capability: 'image-to-image' },
        ],
      },
      'image-edit',
    )
    expect(result?.routeId).toBe('gemini:image-to-image')
    expect(result?.protocol).toBe('gemini')
  })

  test('unrelated capabilities (recognition/upload/video) never fall back', () => {
    const result = selectRouteForOperation(
      {
        id: 'recognizer',
        routes: [
          { id: 'r1', protocol: 'openai', capability: 'image-recognition' },
          { id: 'r2', protocol: 'openai', capability: 'upload' },
        ],
      },
      'image-edit',
    )
    expect(result).toBeUndefined()
  })

  test('Kling / non-openai/gemini/mj protocol returns undefined even with matching capability', () => {
    const result = selectRouteForOperation(
      { id: 'kling', routes: [{ id: 'kling:t2v', protocol: 'kling', capability: 'text-to-image' }] },
      'text-to-image',
    )
    expect(result).toBeUndefined()
  })

  test('MJ Imagine text-to-image route can serve image-edit and text-to-image both', () => {
    const model = { id: 'mj_imagine', routes: [{ id: 'mj:imagine', protocol: 'mj', capability: 'text-to-image' }] }
    expect(selectRouteForOperation(model, 'text-to-image')?.routeId).toBe('mj:imagine')
    expect(selectRouteForOperation(model, 'image-edit')?.routeId).toBe('mj:imagine')
  })

  test('unknown model returns undefined', () => {
    expect(selectRouteForOperation(undefined, 'text-to-image')).toBeUndefined()
  })
})
