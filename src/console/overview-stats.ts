/**
 * 总览页用量统计聚合 —— 纯函数，便于单测。
 *
 * 输入为 UserManager 持久化的全部用户账户，输出总览页所需的
 * 全局合计、模型用量行与用户用量排行行。
 */
import type { UserAccountV2 } from '../services/UserManager.js'

export interface OverviewModelRow {
  modelId: string
  images: number
  percent: string
}

export interface OverviewUserRow {
  userId: string
  userName: string
  images: number
  requests: number
  failed: number
  consumedCredits: number
  purchasedBalance: number
  trialImagesUsed: number
  lastUsedAt?: string
}

export interface OverviewTotals {
  users: number
  totalRequests: number
  totalImages: number
  totalFailed: number
  /** 无请求时为 null，前端展示 — */
  successRate: number | null
  totalConsumedCredits: number
  purchasedBalance: number
  trialImagesUsed: number
}

export interface OverviewStats {
  totals: OverviewTotals
  modelRows: OverviewModelRow[]
  topModel: string | null
  userRows: OverviewUserRow[]
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function buildOverviewStats(users: UserAccountV2[] | null | undefined, userLimit = 20): OverviewStats {
  const list = Array.isArray(users) ? users : []
  const modelCounts: Record<string, number> = {}

  let totalRequests = 0
  let totalImages = 0
  let totalFailed = 0
  let totalConsumedCredits = 0
  let purchasedBalance = 0
  let trialImagesUsed = 0

  const userRows: OverviewUserRow[] = list.map((user) => {
    const statistics = (user?.statistics ?? {}) as Partial<UserAccountV2['statistics']>
    const balance = (user?.balance ?? {}) as Partial<UserAccountV2['balance']>

    const images = num(statistics.totalImagesGenerated)
    const requests = num(statistics.totalGenerationRequests)
    const failed = num(statistics.totalFailedRequests)
    const consumed = num(balance.totalConsumedCredits)
    const purchased = num(balance.purchasedCredits)
    const trial = num(balance.trialImagesUsed)

    totalRequests += requests
    totalImages += images
    totalFailed += failed
    totalConsumedCredits += consumed
    purchasedBalance += purchased
    trialImagesUsed += trial

    const counts = statistics.modelUsageCounts
    if (counts && typeof counts === 'object') {
      for (const [modelId, value] of Object.entries(counts)) {
        const v = num(value)
        if (v > 0) modelCounts[modelId] = (modelCounts[modelId] || 0) + v
      }
    }

    return {
      userId: String(user?.userId ?? ''),
      userName: String(user?.userName ?? ''),
      images,
      requests,
      failed,
      consumedCredits: consumed,
      purchasedBalance: purchased,
      trialImagesUsed: trial,
      lastUsedAt: typeof user?.lastUsedAt === 'string' ? user.lastUsedAt : undefined,
    }
  })

  userRows.sort((a, b) =>
    b.images - a.images
    || b.requests - a.requests
    || a.userId.localeCompare(b.userId, 'zh-CN'))

  const modelRows: OverviewModelRow[] = Object.entries(modelCounts)
    .map(([modelId, images]) => ({
      modelId,
      images,
      percent: totalImages > 0 ? `${((images * 100) / totalImages).toFixed(1)}%` : '—',
    }))
    .sort((a, b) => b.images - a.images)

  return {
    totals: {
      users: list.length,
      totalRequests,
      totalImages,
      totalFailed,
      successRate: totalRequests > 0 ? Math.max(0, (totalRequests - totalFailed) / totalRequests) : null,
      totalConsumedCredits,
      purchasedBalance,
      trialImagesUsed,
    },
    modelRows,
    topModel: modelRows[0]?.modelId ?? null,
    userRows: userRows.slice(0, Math.max(1, userLimit)),
  }
}
