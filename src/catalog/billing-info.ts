import type { NewApiRawSnapshot } from '../suppliers/newapi/raw-types.js'

/**
 * new-api 账单快照。
 *
 * 术语澄清（0.9.1）：`total_usage / 500000` 语义是**供应商积分**（上游 new-api 系
 * 计费单位，官方口径 1 供应商积分 = ¥0.5）。历史字段 `totalUsageUsd` /
 * `platformCredits` 都是同一数值的旧命名，本轮起改暴露 `supplierCredits` 作为
 * 语义正确的入口；`platformCredits` / `totalUsageUsd` 保留同值别名一版，兼容
 * 已经写入磁盘的缓存 JSON 与外部读者，之后再退役。
 *
 * 内部代码请优先使用 `supplierCredits`。
 */
export interface BillingInfo {
  /**
   * 累计消耗的供应商积分（new-api 上游 `total_usage / 500000`）。0.9.1 新增的语义正确入口。
   * 声明为可选是为了让旧测试 fixture / 缓存 JSON 不带此键时仍能反序列化；解析器 always
   * 会填充此字段。运行时读者请用 `supplierCredits ?? platformCredits ?? totalUsageUsd`。
   */
  supplierCredits?: number | null
  /**
   * @deprecated 0.9.1 起改名为 `supplierCredits`；同值别名，仅供旧缓存兼容。
   */
  platformCredits: number | null
  /**
   * @deprecated 0.9.1 起改名为 `supplierCredits`；同值别名，仅供旧序列化兼容。
   */
  totalUsageUsd: number | null
  softLimitUsd?: number
  hardLimitUsd?: number
  tokenName?: string
}

/**
 * 供应商积分与人民币的官方约定：1 供应商积分 = ¥0.5。
 * 名字保持 PLATFORM_CREDIT_TO_RMB 是为了减少 import 更名的爆炸半径；
 * 新代码在阅读时应把它理解为“供应商积分 → 人民币”系数。
 */
export const SUPPLIER_CREDIT_TO_RMB = 0.5
/** @deprecated 使用 SUPPLIER_CREDIT_TO_RMB。 */
export const PLATFORM_CREDIT_TO_RMB = SUPPLIER_CREDIT_TO_RMB

export function normalizeNewApiBilling(snapshot: NewApiRawSnapshot): BillingInfo {
  const usage = snapshot.endpoints.billing.success ? snapshot.endpoints.billing.data : undefined
  const status = snapshot.endpoints.status.success ? snapshot.endpoints.status.data : undefined
  const rawTotal = typeof usage?.total_usage === 'number' ? usage.total_usage : null
  const supplierCredits = rawTotal !== null ? rawTotal / 500000 : null
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
