import { describe, expect, test } from 'vitest'

import {
  AuthenticationError,
  BadRequestError,
  extractUpstreamErrorMessage,
  normalizeProviderError,
} from '../../src/providers/errors.js'

describe('extractUpstreamErrorMessage', () => {
  test('提取 new-api / OpenAI 嵌套 error.message', () => {
    const data = {
      error: {
        message: '当前分组 限时特价 下对于模型 gpt-image-2 无可用渠道',
        type: 'new_api_error',
        code: 'invalid_request',
      },
    }
    expect(extractUpstreamErrorMessage(data)).toBe(
      '当前分组 限时特价 下对于模型 gpt-image-2 无可用渠道',
    )
  })

  test('提取扁平 message / msg 字段', () => {
    expect(extractUpstreamErrorMessage({ message: '余额不足' })).toBe('余额不足')
    expect(extractUpstreamErrorMessage({ msg: '权限不足' })).toBe('权限不足')
  })

  test('error 为字符串时直接使用', () => {
    expect(extractUpstreamErrorMessage({ error: 'model not entitled' })).toBe('model not entitled')
  })

  test('纯文本响应原样返回并压缩空白', () => {
    expect(extractUpstreamErrorMessage('  Forbidden\n\nresource  ')).toBe('Forbidden resource')
  })

  test('无可用信息时返回 undefined', () => {
    expect(extractUpstreamErrorMessage(undefined)).toBeUndefined()
    expect(extractUpstreamErrorMessage(null)).toBeUndefined()
    expect(extractUpstreamErrorMessage({})).toBeUndefined()
    expect(extractUpstreamErrorMessage(42)).toBeUndefined()
    expect(extractUpstreamErrorMessage('   ')).toBeUndefined()
  })

  test('脱敏 Bearer token 与 key 参数', () => {
    const out = extractUpstreamErrorMessage({
      message: 'auth failed for Bearer sk-abcdef1234567890abcdef key=xyz1234567890',
    })
    expect(out).not.toContain('sk-abcdef1234567890abcdef')
    expect(out).not.toContain('xyz1234567890')
    expect(out).toContain('[REDACTED]')
  })

  test('超长文本按 maxLength 截断', () => {
    const out = extractUpstreamErrorMessage({ message: 'x'.repeat(500) }, 100)
    expect(out).toHaveLength(101) // 100 + 省略号
    expect(out?.endsWith('…')).toBe(true)
  })
})

describe('normalizeProviderError 上游错误透出', () => {
  test('403 带 JSON 错误体时 message 并入供应商原始原因', () => {
    const httpError = Object.assign(new Error('Forbidden'), {
      response: {
        status: 403,
        data: { error: { message: '该令牌无权使用 gpt-image-2', type: 'new_api_error' } },
      },
    })
    const normalized = normalizeProviderError(httpError, 'openai')
    expect(normalized).toBeInstanceOf(AuthenticationError)
    expect(normalized.statusCode).toBe(403)
    expect(normalized.message).toBe('Forbidden｜该令牌无权使用 gpt-image-2')
    expect(normalized.retryable).toBe(false)
  })

  test('400 带扁平 message 时同样透出', () => {
    const httpError = Object.assign(new Error('Bad Request'), {
      response: { status: 400, data: { message: 'size 参数不被支持' } },
    })
    const normalized = normalizeProviderError(httpError, 'openai')
    expect(normalized).toBeInstanceOf(BadRequestError)
    expect(normalized.message).toBe('Bad Request｜size 参数不被支持')
  })

  test('无响应体时保持原 message 不变', () => {
    const httpError = Object.assign(new Error('Forbidden'), { response: { status: 403 } })
    const normalized = normalizeProviderError(httpError, 'openai')
    expect(normalized.message).toBe('Forbidden')
  })

  test('上游 message 与 statusText 相同则不去重拼接', () => {
    const httpError = Object.assign(new Error('Forbidden'), {
      response: { status: 403, data: 'Forbidden' },
    })
    const normalized = normalizeProviderError(httpError, 'openai')
    expect(normalized.message).toBe('Forbidden')
  })
})
