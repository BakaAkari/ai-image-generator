import { describe, test, expect } from 'vitest'
import { resolveNewApiRoutes, resolveRoutesFromCapabilities } from '../../src/suppliers/newapi/routes.js'
import type { GenerationRoute } from '../../src/catalog/model-catalog.js'

describe('resolveNewApiRoutes', () => {
  test('image-generation endpoint maps to openai text-to-image', () => {
    const routes = resolveNewApiRoutes(['image-generation'])
    expect(routes).toEqual<GenerationRoute[]>([
      { id: 'openai:text-to-image', protocol: 'openai', capability: 'text-to-image', endpointName: 'image-generation' },
    ])
  })

  test('openai edit endpoint maps to openai image-edit', () => {
    const routes = resolveNewApiRoutes(['openai-编辑'])
    expect(routes).toEqual<GenerationRoute[]>([
      { id: 'openai:image-edit', protocol: 'openai', capability: 'image-edit', endpointName: 'openai-编辑' },
    ])
  })

  test('english OpenAI image edit endpoint maps to openai image-edit (gpt-image family)', () => {
    // gpt-image-2/gpt-image-1.5 在 new-api 站点声明 supported_endpoint_types 为
    // ["OpenAI image edit", "image-generation"]；此前英文端点名不在路由表，图生图被误判不支持。
    const routes = resolveNewApiRoutes(['OpenAI image edit', 'image-generation'])
    expect(routes).toEqual<GenerationRoute[]>([
      { id: 'openai:image-edit', protocol: 'openai', capability: 'image-edit', endpointName: 'OpenAI image edit' },
      { id: 'openai:text-to-image', protocol: 'openai', capability: 'text-to-image', endpointName: 'image-generation' },
    ])
  })

  test('generic edit endpoint maps to openai image-edit', () => {
    const routes = resolveNewApiRoutes(['edit'])
    expect(routes).toEqual<GenerationRoute[]>([
      { id: 'openai:image-edit', protocol: 'openai', capability: 'image-edit', endpointName: 'edit' },
    ])
  })

  test('gemini endpoint maps to explicit text-to-image and image-to-image routes', () => {
    const routes = resolveNewApiRoutes(['gemini'])
    expect(routes).toEqual<GenerationRoute[]>([
      { id: 'gemini:text-to-image', protocol: 'gemini', capability: 'text-to-image', endpointName: 'gemini' },
      { id: 'gemini:image-to-image', protocol: 'gemini', capability: 'image-to-image', endpointName: 'gemini' },
    ])
  })

  test('dall-e-3 endpoint maps to openai text-to-image', () => {
    const routes = resolveNewApiRoutes(['dall-e-3'])
    expect(routes).toEqual<GenerationRoute[]>([
      { id: 'openai:text-to-image', protocol: 'openai', capability: 'text-to-image', endpointName: 'dall-e-3' },
    ])
  })

  test('unknown endpoint yields no route', () => {
    const routes = resolveNewApiRoutes(['数字人'])
    expect(routes).toEqual([])
  })

  test('mixed endpoints drop unknowns and keep all known capability routes', () => {
    const routes = resolveNewApiRoutes(['image-generation', '图像识别', 'gemini'])
    expect(routes.map(r => r.id)).toEqual([
      'openai:text-to-image',
      'gemini:text-to-image',
      'gemini:image-to-image',
    ])
  })

  // ---------------------------------------------------------------------------
  // 语义规则引擎（v2.3）：不再依赖穷举端点名表，语义变体自动识别
  // ---------------------------------------------------------------------------

  test('MJ imagine 英文端点直接识别为 mj 协议（无需 endpointAliases）', () => {
    const routes = resolveNewApiRoutes(['MJ imagine'])
    expect(routes).toEqual<GenerationRoute[]>([
      { id: 'mj:text-to-image', protocol: 'mj', capability: 'text-to-image', endpointName: 'MJ imagine' },
    ])
  })

  test('mj想象模式 中文端点识别为 mj 协议', () => {
    const routes = resolveNewApiRoutes(['mj想象模式'])
    expect(routes).toEqual<GenerationRoute[]>([
      { id: 'mj:text-to-image', protocol: 'mj', capability: 'text-to-image', endpointName: 'mj想象模式' },
    ])
  })

  test('MJ blend 英文端点识别为 mj image-edit（供 compose-image 选择 blend 契约）', () => {
    const routes = resolveNewApiRoutes(['MJ blend'])
    expect(routes).toEqual<GenerationRoute[]>([
      { id: 'mj:image-edit', protocol: 'mj', capability: 'image-edit', endpointName: 'MJ blend' },
    ])
  })

  test('编辑语义变体全部识别为 openai image-edit', () => {
    for (const ep of ['images/edits', 'images-edits', 'image edit 2', 'openai-编辑', 'edit-image', 'openaiEdits']) {
      const routes = resolveNewApiRoutes([ep])
      expect(routes.map(r => r.id)).toEqual(['openai:image-edit'])
      expect(routes[0].endpointName).toBe(ep)
    }
  })

  test('生成语义变体全部识别为 openai text-to-image', () => {
    for (const ep of ['image-generation', 'images/generations', 'dall-e-4', 'openai-绘图', 'image-generate']) {
      const routes = resolveNewApiRoutes([ep])
      expect(routes.map(r => r.id)).toEqual(['openai:text-to-image'])
      expect(routes[0].endpointName).toBe(ep)
    }
  })

  test('gemini 大小写变体识别为 gemini 双能力', () => {
    const routes = resolveNewApiRoutes(['Gemini'])
    expect(routes.map(r => r.id)).toEqual(['gemini:text-to-image', 'gemini:image-to-image'])
  })

  test('未接入契约的 MJ 操作 fail-closed 不产出路由', () => {
    for (const ep of ['MJ action', 'MJ describe', 'MJ modal', 'MJ upscale', 'mj动作']) {
      expect(resolveNewApiRoutes([ep])).toEqual([])
    }
  })

  test('Kling 系列 fail-closed 不产出路由', () => {
    for (const ep of ['Kling image generation', 'Kling multi-image to image', 'Kling image expand']) {
      expect(resolveNewApiRoutes([ep])).toEqual([])
    }
  })

  test('阻断语义（recognition/video/upload/template）不产出路由', () => {
    for (const ep of ['Image recognition', '数字人', 'image-to-video', 'mj图片上传', '图片模板']) {
      expect(resolveNewApiRoutes([ep])).toEqual([])
    }
  })

  test('openlux 真实 18 种图像端点全量分类正确', () => {
    const openluxEndpoints: Array<[string, string[] | 'BLOCK']> = [
      ['image-generation', ['openai:text-to-image']],
      ['MJ action', 'BLOCK'],
      ['gemini', ['gemini:text-to-image', 'gemini:image-to-image']],
      ['openai', ['openai:text-to-image']],
      ['dall-e-3', ['openai:text-to-image']],
      ['OpenAI image edit', ['openai:image-edit']],
      ['images-generations', ['openai:text-to-image']],
      ['MJ describe', 'BLOCK'],
      ['Image recognition', 'BLOCK'],
      ['MJ blend', ['mj:image-edit']],
      ['MJ imagine', ['mj:text-to-image']],
      ['omni-image', 'BLOCK'], // kling-omni-image（Kling Omni，未接入契约）
      ['openai-编辑', ['openai:image-edit']],
      ['openai-绘图', ['openai:text-to-image']],
      ['MJ modal', 'BLOCK'],
      ['Kling image generation', 'BLOCK'],
      ['Kling multi-image to image', 'BLOCK'],
      ['Kling image expand', 'BLOCK'],
    ]
    for (const [ep, expected] of openluxEndpoints) {
      const routes = resolveNewApiRoutes([ep])
      const ids = routes.map(r => r.id)
      if (expected === 'BLOCK') {
        expect(ids, `endpoint=${ep} should be blocked`).toEqual([])
      } else {
        expect(ids, `endpoint=${ep}`).toEqual(expected)
      }
    }
  })

  test('endpointAliases 优先级最高：覆盖语义规则', () => {
    // 用户显式把 image-generation 覆盖为 mj 协议（异常但允许）
    const routes = resolveNewApiRoutes(['image-generation'], {
      'image-generation': { protocol: 'mj', capability: 'text-to-image' },
    })
    expect(routes.map(r => r.id)).toEqual(['mj:text-to-image'])
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
