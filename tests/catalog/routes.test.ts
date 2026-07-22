import { describe, test, expect } from 'vitest'
import { resolveYunwuRoutes } from '../../src/suppliers/yunwu/routes.js'
import type { YunwuModelItem } from '../../src/suppliers/yunwu/raw-types.js'

describe('resolveYunwuRoutes', () => {
  test('openai image generation endpoint yields openai route', () => {
    const m: YunwuModelItem = { id: 'gpt-image-2', supported_endpoint_types: ['image-generation'] }
    const routes = resolveYunwuRoutes(m)
    expect(routes).toHaveLength(1)
    expect(routes[0]!.protocol).toBe('openai')
  })

  test('gemini endpoint yields gemini route', () => {
    const m: YunwuModelItem = { id: 'gemini-3-pro-image', supported_endpoint_types: ['gemini'] }
    const routes = resolveYunwuRoutes(m)
    expect(routes).toHaveLength(1)
    expect(routes[0]!.protocol).toBe('gemini')
  })

  test('mixed endpoints yield both routes without duplication', () => {
    const m: YunwuModelItem = { id: 'gemini-3-pro-image', supported_endpoint_types: ['gemini', 'openai'] }
    const routes = resolveYunwuRoutes(m)
    const protocols = routes.map(r => r.protocol)
    expect(protocols).toContain('gemini')
    expect(protocols).toContain('openai')
  })

  test('unknown endpoint yields no routes', () => {
    const m: YunwuModelItem = { id: 'weird', supported_endpoint_types: ['unknown-endpoint'] }
    const routes = resolveYunwuRoutes(m)
    expect(routes).toHaveLength(0)
  })

  test('non-generation endpoints yield no routes', () => {
    const m: YunwuModelItem = { id: 'mj_upload', supported_endpoint_types: ['mj图片上传'] }
    const routes = resolveYunwuRoutes(m)
    expect(routes).toHaveLength(0)
  })
})
