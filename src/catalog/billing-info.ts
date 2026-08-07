import type { NewApiRawSnapshot } from '../suppliers/newapi/raw-types.js'
import { USD_TO_RMB as SHARED_USD_TO_RMB } from '../shared/billing.js'

/**
 * new-api 账单快照。
 *
 * `/v1/dashboard/billing/usage.total_usage` = **真实美元 × 100**（不是美元、也不是 quota 单位）。
 * 真相铁证 2026-08-06：账户充值 $50 / 余额 $48.96 / 消耗 $1.25，同时 total_usage 在门户显示
 * 的读数与真实美元差 100 倍。此前 0.9.1 除以 500000（把它当 quota）与 1.1.1 直取（把它当美元）
 * 都是误读；正确归一化是 `supplierCredits = total_usage / 100`。
 *
 * 字段名保持 `supplierCredits` 以兼容磁盘缓存与外部读者，语义为「累计消耗 USD」。
 * 历史别名 `totalUsageUsd` / `platformCredits` 是同一数值。
 */
export interface BillingInfo {
  /**
   * 累计消耗的美元（由 `total_usage / 100` 得到，见文件头注释）。字段名保留 supplierCredits
   * 以兼容磁盘缓存，语义为「累计消耗 USD」。
   * 声明为可选是为了让旧测试 fixture / 缓存 JSON 不带此键时仍能反序列化；解析器 always
   * 会填充此字段。运行时读者请用 `supplierCredits ?? platformCredits ?? totalUsageUsd`。
   */
  supplierCredits?: number | null
  /** @deprecated 改名为 `supplierCredits`；同值别名，仅供旧缓存兼容。 */
  platformCredits: number | null
  /** @deprecated 改名为 `supplierCredits`；同值别名，仅供旧序列化兼容。 */
  totalUsageUsd: number | null
  softLimitUsd?: number
  hardLimitUsd?: number
  tokenName?: string
}

/**
 * 美元→人民币汇率。真源在 `shared/billing.ts`，此处仅重导出以避免 import 位置爆炸。
 * 修改请到 shared/billing.ts。
 */
export const USD_TO_RMB = SHARED_USD_TO_RMB
/** @deprecated 使用 USD_TO_RMB。同值别名。 */
export const SUPPLIER_CREDIT_TO_RMB = USD_TO_RMB
/** @deprecated 使用 USD_TO_RMB。 */
export const PLATFORM_CREDIT_TO_RMB = USD_TO_RMB

export function normalizeNewApiBilling(snapshot: NewApiRawSnapshot): BillingInfo {
  const usage = snapshot.endpoints.billing.success ? snapshot.endpoints.billing.data : undefined
  const status = snapshot.endpoints.status.success ? snapshot.endpoints.status.data : undefined
  const rawTotal = typeof usage?.total_usage === 'number' ? usage.total_usage : null
  // total_usage = 真实美元 × 100（见文件头注释；此前误读 500000 与直取都是错的）
  const supplierCredits = rawTotal != null ? rawTotal / 100 : null
  const info: BillingInfo = {
    supplierCredits,
    platformCredits: supplierCredits,
    totalUsageUsd: supplierCredits,
  }
  const soft = status?.soft_limit_usd ?? usage?.soft_limit_usd
  const hard = status?.hard_limit_usd ?? usage?.hard_limit_usd
  const tokenName = status?.token_name ?? usage?.token_name
  if (typeof soft === 'number') info.softLimitUsd = soft
  if (typeof hard === 'number') info.hardLimitUsd = hard
  if (typeof tokenName === 'string') info.tokenName = tokenName
  return info
}
