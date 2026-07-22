import { describe, expect, test, vi } from 'vitest'
import { ImageCatalogService } from '../../src/catalog/image-catalog.js'

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
      supplier: 'yunwu',
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
})
