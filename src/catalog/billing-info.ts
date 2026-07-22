import type { YunwuRawSnapshot } from '../suppliers/yunwu/raw-types.js'

export interface BillingInfo {
  totalUsageUsd: number | null
  softLimitUsd?: number
  hardLimitUsd?: number
  tokenName?: string
}

export function normalizeYunwuBilling(snapshot: YunwuRawSnapshot): BillingInfo {
  const usage = snapshot.endpoints.billing.success ? snapshot.endpoints.billing.data : undefined
  const status = snapshot.endpoints.status.success ? snapshot.endpoints.status.data : undefined
  const info: BillingInfo = {
    totalUsageUsd: typeof usage?.total_usage === 'number' ? usage.total_usage / 500000 : null,
  }
  const soft = status?.soft_limit_usd ?? usage?.soft_limit_usd
  const hard = status?.hard_limit_usd ?? usage?.hard_limit_usd
  const tokenName = status?.token_name ?? usage?.token_name
  if (typeof soft === 'number') info.softLimitUsd = soft
  if (typeof hard === 'number') info.hardLimitUsd = hard
  if (typeof tokenName === 'string') info.tokenName = tokenName
  return info
}
