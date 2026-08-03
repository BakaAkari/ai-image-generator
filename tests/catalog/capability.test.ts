import { describe, test, expect } from 'vitest'
import { resolveNewApiCapabilities, isNewApiExecutableImageModel } from '../../src/suppliers/newapi/capability.js'
import type { NewApiModelItem } from '../../src/suppliers/newapi/raw-types.js'

describe('resolveNewApiCapabilities', () => {
  test('gpt-image-2 with openai generation and edit endpoints yields text-to-image and image-edit', () => {
    const item: NewApiModelItem = {
      id: 'gpt-image-2',
      model_type: '图像',
      supported_endpoint_types: ['openai编辑图片', 'image-generation'],
      available: true,
    }
    const { capabilities } = resolveNewApiCapabilities(item)
    expect(capabilities).toContain('text-to-image')
    expect(capabilities).toContain('image-edit')
  })

  test('gemini-3-pro-image with gemini/openai endpoints yields text-to-image and image-to-image', () => {
    const item: NewApiModelItem = {
      id: 'gemini-3-pro-image',
      model_type: '图像',
      supported_endpoint_types: ['gemini', 'openai'],
      available: true,
    }
    const { capabilities } = resolveNewApiCapabilities(item)
    expect(capabilities).toContain('text-to-image')
    expect(capabilities).toContain('image-to-image')
  })

  test('grok-imagine-image with dall-e-3 endpoint yields text-to-image', () => {
    const item: NewApiModelItem = {
      id: 'grok-imagine-image',
      model_type: '图像',
      supported_endpoint_types: ['dall-e-3'],
      available: true,
    }
    const { capabilities } = resolveNewApiCapabilities(item)
    expect(capabilities).toContain('text-to-image')
  })

  test('dall-e-3 with empty endpoints but image model_type yields no capabilities (fail-closed)', () => {
    const item: NewApiModelItem = {
      id: 'dall-e-3',
      model_type: '图像',
      supported_endpoint_types: [],
      available: true,
    }
    const { capabilities } = resolveNewApiCapabilities(item)
    expect(capabilities).toEqual([])
  })

  test('kling-avatar-image2video is blocked as video endpoint', () => {
    const item: NewApiModelItem = {
      id: 'kling-avatar-image2video',
      model_type: '音视频',
      supported_endpoint_types: ['数字人'],
      available: true,
    }
    const { capabilities } = resolveNewApiCapabilities(item)
    expect(capabilities).toEqual([])
  })

  test('kling-image-recognize is blocked as recognition endpoint', () => {
    const item: NewApiModelItem = {
      id: 'kling-image-recognize',
      model_type: '图像',
      supported_endpoint_types: ['图像识别'],
      available: true,
    }
    const { capabilities } = resolveNewApiCapabilities(item)
    expect(capabilities).toEqual([])
  })

  test('mj_upload is blocked as upload endpoint', () => {
    const item: NewApiModelItem = {
      id: 'mj_upload',
      model_type: '',
      supported_endpoint_types: ['mj图片上传'],
      available: true,
    }
    const { capabilities } = resolveNewApiCapabilities(item)
    expect(capabilities).toEqual([])
  })

  test('mj_imagine with English MJ imagine endpoint yields mj text-to-image without alias', () => {
    const item: NewApiModelItem = {
      id: 'mj_imagine',
      model_type: '图像',
      supported_endpoint_types: ['MJ imagine'],
      available: true,
    }
    const { capabilities, reasons } = resolveNewApiCapabilities(item)
    expect(capabilities).toContain('text-to-image')
    expect(reasons.some(r => r.includes('mj imagine'))).toBe(true)
  })

  test('pixverse-image-template is blocked as template endpoint', () => {
    const item: NewApiModelItem = {
      id: 'pixverse-image-template',
      model_type: '音视频',
      supported_endpoint_types: ['图片模板'],
      available: true,
    }
    const { capabilities } = resolveNewApiCapabilities(item)
    expect(capabilities).toEqual([])
  })

  test('mj_video with empty endpoints and empty model_type is blocked', () => {
    const item: NewApiModelItem = {
      id: 'mj_video',
      model_type: '',
      supported_endpoint_types: [],
      available: true,
    }
    const { capabilities } = resolveNewApiCapabilities(item)
    expect(capabilities).toEqual([])
  })
})

describe('isNewApiExecutableImageModel', () => {
  test('returns true for explicit image generation models', () => {
    const item: NewApiModelItem = {
      id: 'gpt-image-2',
      model_type: '图像',
      supported_endpoint_types: ['image-generation'],
      available: true,
    }
    expect(isNewApiExecutableImageModel(item)).toBe(true)
  })

  test('returns false for non-image model_type', () => {
    const item: NewApiModelItem = {
      id: 'kling-avatar-image2video',
      model_type: '音视频',
      supported_endpoint_types: ['数字人'],
      available: true,
    }
    expect(isNewApiExecutableImageModel(item)).toBe(false)
  })

  test('returns false for recognition-only models', () => {
    const item: NewApiModelItem = {
      id: 'kling-image-recognize',
      model_type: '图像',
      supported_endpoint_types: ['图像识别'],
      available: true,
    }
    expect(isNewApiExecutableImageModel(item)).toBe(false)
  })
})
