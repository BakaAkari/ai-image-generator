/**
 * log-quota 工具单测：验证 queryLogQuotaByRequestId 的核心路径。
 *
 * 覆盖：
 * - Bearer + New-Api-User 请求头拼装正确
 * - request_id 命中 → 返回 { quota, group }
 * - 未命中 / 空 items → null
 * - HTTP 非 2xx → null（不抛）
 * - 网络异常 → null（不抛）
 */

import { describe, test, expect } from 'vitest'

import { queryLogQuotaByRequestId } from '../../src/services/log-quota.js'
import type { LogAccessCredentials } from '../../src/services/log-quota.js'

const CREDS: LogAccessCredentials = {
  apiBase: 'https://api.openlux.ai/v1',
  apiKey: 'log-key',
  userId: 42,
}

function fakeResponse(payload: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => payload,
  } as unknown as Response
}

describe('queryLogQuotaByRequestId', () => {
  test('拼装 /api/log/self 请求：Bearer + New-Api-User，v1 后缀被剥离', async () => {
    let capturedUrl = ''
    let capturedHeaders: Record<string, string> = {}
    const fetchLike = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedHeaders = init?.headers as Record<string, string>
      return fakeResponse({ data: { items: [{ quota: 6618, request_id: 'req-abc', group: 'MJ-1' }] } })
    }) as unknown as typeof fetch

    const result = await queryLogQuotaByRequestId(CREDS, 'req-abc', { fetchLike })
    expect(capturedUrl).toBe('https://api.openlux.ai/api/log/self?request_id=req-abc')
    expect(capturedHeaders.Authorization).toBe('Bearer log-key')
    expect(capturedHeaders['New-Api-User']).toBe('42')
    expect(result).toEqual({ quota: 6618, group: 'MJ-1' })
  })

  test('data 为数组结构（无 items 包装）也能解析', async () => {
    const fetchLike = (async () => fakeResponse({
      data: [{ quota: 8000, request_id: 'req-plain' }],
    })) as unknown as typeof fetch
    const result = await queryLogQuotaByRequestId(CREDS, 'req-plain', { fetchLike })
    expect(result).toEqual({ quota: 8000, group: null })
  })

  test('request_id 未命中 → 返回列表第一条兜底（若存在）', async () => {
    const fetchLike = (async () => fakeResponse({
      data: { items: [{ quota: 123, request_id: 'other', group: null }] },
    })) as unknown as typeof fetch
    const result = await queryLogQuotaByRequestId(CREDS, 'req-nope', { fetchLike })
    expect(result).toEqual({ quota: 123, group: null })
  })

  test('items 为空 → null', async () => {
    const fetchLike = (async () => fakeResponse({ data: { items: [] } })) as unknown as typeof fetch
    const result = await queryLogQuotaByRequestId(CREDS, 'req-abc', { fetchLike })
    expect(result).toBeNull()
  })

  test('HTTP 非 2xx → null（不抛）', async () => {
    const fetchLike = (async () => fakeResponse({}, { ok: false, status: 404 })) as unknown as typeof fetch
    const result = await queryLogQuotaByRequestId(CREDS, 'req-abc', { fetchLike })
    expect(result).toBeNull()
  })

  test('网络异常 → null（不抛）', async () => {
    const fetchLike = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    const result = await queryLogQuotaByRequestId(CREDS, 'req-abc', { fetchLike })
    expect(result).toBeNull()
  })

  test('空 requestId → null，不发起请求', async () => {
    let called = false
    const fetchLike = (async () => { called = true; return fakeResponse({}) }) as unknown as typeof fetch
    const result = await queryLogQuotaByRequestId(CREDS, '', { fetchLike })
    expect(result).toBeNull()
    expect(called).toBe(false)
  })

  test('quota 非数值 → null', async () => {
    const fetchLike = (async () => fakeResponse({
      data: { items: [{ quota: 'oops', request_id: 'req-abc' }] },
    })) as unknown as typeof fetch
    const result = await queryLogQuotaByRequestId(CREDS, 'req-abc', { fetchLike })
    expect(result).toBeNull()
  })
})
