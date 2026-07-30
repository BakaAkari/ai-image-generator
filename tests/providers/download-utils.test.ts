import { describe, expect, test, vi } from 'vitest'

import { downloadImageAsBase64 } from '../../src/providers/utils.js'

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} }

describe('downloadImageAsBase64 internal 协议失败', () => {
  test('错误消息保留上游 HTTP 状态码，不被笼统文案吞掉', async () => {
    const ctx = {
      http: {
        file: vi.fn(async () => {
          throw new Error(
            'Failed to fetch internal:lark/ou_x/im/v1/messages/om_x/resources/v2_abc?type=image, status code: 500',
          )
        }),
      },
    } as any

    await expect(
      downloadImageAsBase64(
        ctx,
        'internal:lark/ou_x/im/v1/messages/om_x/resources/v2_abc?type=image',
        10,
        noopLogger,
      ),
    ).rejects.toThrow(/无法获取飞书\/Lark 图片资源\(HTTP 500\)/)
  })

  test('无状态码时仍给出明确错误而非吞掉', async () => {
    const ctx = {
      http: {
        file: vi.fn(async () => {
          throw new Error('socket hang up')
        }),
      },
    } as any

    await expect(
      downloadImageAsBase64(ctx, 'internal:lark/ou_x/some/path', 10, noopLogger),
    ).rejects.toThrow(/无法获取飞书\/Lark 图片资源/)
  })
})
