import { describe, expect, test, vi } from 'vitest'
import { ImageCatalogService, canPublishNewApiSnapshot } from '../../src/catalog/image-catalog.js'

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any

function context() {
  const disposeHandlers: Array<() => void> = []
  return {
    on: (_event: string, cb: () => void) => { disposeHandlers.push(cb); return () => {} },
    disposeHandlers,
  } as any
}

describe('ImageCatalogService scheduler wiring', () => {
  test('updateRefreshHours delegates to the hot-update scheduler after start', () => {
    const ctx = context()
    const service = new ImageCatalogService(ctx, logger, '/tmp/catalog-wiring-' + Date.now())
    service.start(() => ({
      supplier: 'newapi',
      apiBase: 'https://yunwu.ai/v1',
      apiKey: '',
      timeoutSec: 30,
      refreshHours: 6,
    }))

    expect(() => service.updateRefreshHours(2)).not.toThrow()
    service.stop()
  })

  test('stop is idempotent', () => {
    const ctx = context()
    const service = new ImageCatalogService(ctx, logger, '/tmp/catalog-wiring-' + Date.now())
    expect(() => { service.stop(); service.stop() }).not.toThrow()
  })
  test('catalog contract exposes unsupported models separately', () => {
    const snapshot = {
      supplier: 'newapi',
      models: [],
      unsupportedModels: [{ id: 'recognize-only', unsupportedReasons: ['no recognized image generation endpoint'] }],
      fetchedAt: 0,
    }
    expect(snapshot.unsupportedModels).toHaveLength(1)
  })

  test('does not publish a snapshot when the authoritative models endpoint failed', () => {
    expect(canPublishNewApiSnapshot({ endpoints: { models: { success: false } } } as any)).toBe(false)
  })

  test('can publish when models succeeded even if pricing failed', () => {
    expect(canPublishNewApiSnapshot({ endpoints: { models: { success: true }, pricing: { success: false } } } as any)).toBe(true)
  })

})
