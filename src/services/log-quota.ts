/**
 * NewAPI 日志真源查询工具。
 *
 * 门户「计费过程」显示的真实美元 = quota / 500000。生成完成后按 request_id 查
 * `/api/log/self`（Bearer logAccessApiKey + New-Api-User）拿到该请求的权威 quota，
 * 用于结算路径（尤其 MJ 逐任务精确计费）。
 *
 * 抽自旧 ModelProbeService.lookupLogQuota，剥离探测语义，只保留一个纯查询函数。
 */

export interface LogAccessCredentials {
  apiBase: string
  apiKey: string
  userId: number
  extraHeaders?: Record<string, string>
  timeoutSec?: number
}

export interface LogQuotaResult {
  quota: number
  group?: string | null
}

export interface QueryLogQuotaOptions {
  fetchLike?: typeof fetch
}

/**
 * 按 request_id 查询 `/api/log/self`；返回 quota + group（若存在），未命中或异常返回 null。
 *
 * 请求头：Authorization: Bearer <logAccessApiKey>，New-Api-User: <logAccessUserId>。
 */
export async function queryLogQuotaByRequestId(
  creds: LogAccessCredentials,
  requestId: string,
  options?: QueryLogQuotaOptions,
): Promise<LogQuotaResult | null> {
  if (!requestId) return null
  const fetchLike = options?.fetchLike ?? globalThis.fetch.bind(globalThis)
  const base = normalizeBase(creds.apiBase)
  const url = `${base}/api/log/self?request_id=${encodeURIComponent(requestId)}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), (creds.timeoutSec ?? 15) * 1000)
  try {
    const res = await fetchLike(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        'New-Api-User': String(creds.userId),
        ...(creds.extraHeaders ?? {}),
      },
      signal: controller.signal,
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => null) as {
      data?:
        | { items?: Array<{ quota?: number; request_id?: string; group?: string }> }
        | Array<{ quota?: number; request_id?: string; group?: string }>
    } | null
    if (!data || !data.data) return null
    const list = Array.isArray(data.data) ? data.data : (data.data.items ?? [])
    const match = list.find(item => item?.request_id === requestId) ?? list[0]
    if (match && typeof match.quota === 'number' && Number.isFinite(match.quota)) {
      return { quota: match.quota, group: match.group ?? null }
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function normalizeBase(apiBase: string): string {
  const trimmed = apiBase.trim().replace(/\/$/, '')
  if (trimmed.endsWith('/v1')) return trimmed.slice(0, -3)
  return trimmed
}
