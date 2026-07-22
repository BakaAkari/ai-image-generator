import { describe, test, expect } from 'vitest'
import { resolveYunwuCapabilities, isYunwuExecutableImageModel } from '../../src/suppliers/yunwu/capability.js'
import type { YunwuModelItem } from '../../src/suppliers/yunwu/raw-types.js'

describe('resolveYunwuCapabilities', () => {
  test('gpt-image-2 with openai generation and edit endpoints yields text-to-image and image-edit', () => {
    const item: YunwuModelItem = {
      id: 'gpt-image-2',
      model_type: '图像',
      supported_endpoint_types: ['openai编辑图片', 'image-generation'],
      available: true,
    }
    const { capabilities } = resolveYunwuCapabilities(item)
    expect(capabilities).toContain('text-to-image')
    expect(capabilities).toContain('image-edit')
  })

  test('gemini-3-pro-image with gemini/openai endpoints yields text-to-image and image-to-image', () => {
    const item: YunwuModelItem = {
      id: 'gemini-3-pro-image',
      model_type: '图像',
      supported_endpoint_types: ['gemini', 'openai'],
      available: true,
    }
    const { capabilities } = resolveYunwuCapabilities(item)
    expect(capabilities).toContain('text-to-image')
    expect(capabilities).toContain('image-to-image')
  })

  test('grok-imagine-image with dall-e-3 endpoint yields text-to-image', () => {
    const item: YunwuModelItem = {
      id: 'grok-imagine-image',
      model_type: '图像',
      supported_endpoint_types: ['dall-e-3'],
      available: true,
    }
    const { capabilities } = resolveYunwuCapabilities(item)
    expect(capabilities).toContain('text-to-image')
  })

  test('dall-e-3 with empty endpoints but image model_type yields no capabilities (fail-closed)', () => {
    const item: YunwuModelItem = {
      id: 'dall-e-3',
      model_type: '图像',
      supported_endpoint_types: [],
      available: true,
    }
    const { capabilities } = resolveYunwuCapabilities(item)
    expect(capabilities).toEqual([])
  })

  test('kling-avatar-image2video is blocked as video endpoint', () => {
    const item: YunwuModelItem = {
      id: 'kling-avatar-image2video',
      model_type: '音视频',
      supported_endpoint_types: ['数字人'],
      available: true,
    }
    const { capabilities } = resolveYunwuCapabilities(item)
    expect(capabilities).toEqual([])
  })

  test('kling-image-recognize is blocked as recognition endpoint', () => {
    const item: YunwuModelItem = {
      id: 'kling-image-recognize',
      model_type: '图像',
      supported_endpoint_types: ['图像识别'],
      available: true,
    }
    const { capabilities } = resolveYunwuCapabilities(item)
    expect(capabilities).toEqual([])
  })

  test('mj_upload is blocked as upload endpoint', () => {
    const item: YunwuModelItem = {
      id: 'mj_upload',
      model_type: '',
      supported_endpoint_types: ['mj图片上传'],
      available: true,
    }
    const { capabilities } = resolveYunwuCapabilities(item)
    expect(capabilities).toEqual([])
  })

  test('pixverse-image-template is blocked as template endpoint', () => {
    const item: YunwuModelItem = {
      id: 'pixverse-image-template',
      model_type: '音视频',
      supported_endpoint_types: ['图片模板'],
      available: true,
    }
    const { capabilities } = resolveYunwuCapabilities(item)
    expect(capabilities).toEqual([])
  })

  test('mj_video with empty endpoints and empty model_type is blocked', () => {
    const item: YunwuModelItem = {
      id: 'mj_video',
      model_type: '',
      supported_endpoint_types: [],
      available: true,
    }
    const { capabilities } = resolveYunwuCapabilities(item)
    expect(capabilities).toEqual([])
  })
})

describe('isYunwuExecutableImageModel', () => {
  test('returns true for explicit image generation models', () => {
    const item: YunwuModelItem = {
      id: 'gpt-image-2',
      model_type: '图像',
      supported_endpoint_types: ['image-generation'],
      available: true,
    }
    expect(isYunwuExecutableImageModel(item)).toBe(true)
  })

  test('returns false for non-image model_type', () => {
    const item: YunwuModelItem = {
      id: 'kling-avatar-image2video',
      model_type: '音视频',
      supported_endpoint_types: ['数字人'],
      available: true,
    }
    expect(isYunwuExecutableImageModel(item)).toBe(false)
  })

  test('returns false for recognition-only models', () => {
    const item: YunwuModelItem = {
      id: 'kling-image-recognize',
      model_type: '图像',
      supported_endpoint_types: ['图像识别'],
      available: true,
    }
    expect(isYunwuExecutableImageModel(item)).toBe(false)
  })
})
