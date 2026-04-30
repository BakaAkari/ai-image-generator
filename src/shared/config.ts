/**
 * V2 配置类型 —— Phase 1 临时 Stub。
 *
 * 仅包含 cherry-pick 文件（UserManager.ts、prompt-timeout.ts）所需的字段。
 * Phase 3 会基于 v5.0 Tagged Union Schema 完整重写此文件，
 * 届时本 stub 中的所有字段都会被覆盖到正式 Schema.intersect 设计中。
 *
 * 已知字段来源（grep `config.<field>` from cherry-picked files）：
 * - UserManager.ts: adminUsers / permanentMembers / modelWhitelistUsers /
 *   unlimitedPlatforms / dailyFreeLimit / rateLimitWindow / rateLimitMax /
 *   securityBlockWindow / securityBlockWarningThreshold
 * - prompt-timeout.ts: apiTimeout
 */
export interface Config {
  // 权限管理
  adminUsers?: string[]
  permanentMembers?: string[]
  modelWhitelistUsers?: string[]
  unlimitedPlatforms?: string[]

  // 配额限制
  dailyFreeLimit: number

  // 限流
  rateLimitWindow: number
  rateLimitMax: number

  // 安全拦截
  securityBlockWindow: number
  securityBlockWarningThreshold: number

  // 超时（秒）
  apiTimeout: number
}
