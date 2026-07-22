import { describe, test, expect } from 'vitest'
import { resolveYunwuCapabilities } from '../../src/suppliers/yunwu/capability.js'
import type { YunwuModelItem } from '../../src/suppliers/yunwu/raw-types.js'

describe('resolveYunwuCapabilities', () => {
  test('openai image generation model gets text-to-image and image-to-image', () => {
    const m: YunwuModelItem = {
      id: 'gpt-image-2',
      supported_endpoint_types: ['image-generation'],
      model_type: '图像',
    }
    const caps = resolveYunwuCapabilities(m)
    expect(caps).toContain('text-to-image')
    expect(caps).toContain('image-to-image')
  })

  test('kling avatar video is classified as avatar/video', () => {
    const m: YunwuModelItem = {
      id: 'kling-avatar-image2video',
      supported_endpoint_types: ['数字人'],
      model_type: '音视频',
    }
    const caps = resolveYunwuCapabilities(m)
    expect(caps).toContain('avatar')
    expect(caps).toContain('video-generation')
    expect(caps).not.toContain('text-to-image')
  })

  test('kling image recognition is classified as image-recognition', () => {
    const m: YunwuModelItem = {
      id: 'kling-image-recognize',
      supported_endpoint_types: ['图像识别'],
      model_type: '图像',
    }
    const caps = resolveYunwuCapabilities(m)
    expect(caps).toContain('image-recognition')
    expect(caps).not.toContain('text-to-image')
  })

  test('mj upload is classified as upload', () => {
    const m: YunwuModelItem = {
      id: 'mj_upload',
      supported_endpoint_types: ['mj图片上传'],
      model_type: '',
    }
    const caps = resolveYunwuCapabilities(m)
    expect(caps).toContain('upload')
    expect(caps).not.toContain('text-to-image')
  })

  test('unknown endpoint yields unknown capability', () => {
    const m: YunwuModelItem = {
      id: 'weird-model',
      supported_endpoint_types: ['unknown-endpoint'],
      model_type: '其他',
    }
    const caps = resolveYunwuCapabilities(m)
    expect(caps).toContain('unknown')
  })
})
