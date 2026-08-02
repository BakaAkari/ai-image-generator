import { describe, expect, test } from 'vitest'

import { buildOverviewStats } from '../../src/console/overview-stats.js'
import type { UserAccountV2 } from '../../src/services/UserManager.js'

function makeUser(overrides: Partial<UserAccountV2> = {}): UserAccountV2 {
  return {
    userId: 'u1',
    userName: '用户1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    balance: {
      trialImagesUsed: 0,
      purchasedCredits: 0,
      totalGrantedCredits: 0,
      totalConsumedCredits: 0,
      totalRefundedCredits: 0,
    },
    statistics: {
      totalImagesGenerated: 0,
      totalGenerationRequests: 0,
      totalFailedRequests: 0,
      modelUsageCounts: {},
    },
    flags: {},
    ...overrides,
  } as UserAccountV2
}

describe('buildOverviewStats', () => {
  test('empty / null input returns zeroed totals', () => {
    const stats = buildOverviewStats(null)
    expect(stats.totals).toEqual({
      users: 0,
      totalRequests: 0,
      totalImages: 0,
      totalFailed: 0,
      successRate: null,
      totalConsumedCredits: 0,
      purchasedBalance: 0,
      trialImagesUsed: 0,
    })
    expect(stats.modelRows).toEqual([])
    expect(stats.topModel).toBeNull()
    expect(stats.userRows).toEqual([])
  })

  test('aggregates requests, images, failures, credits and model distribution', () => {
    const stats = buildOverviewStats([
      makeUser({
        userId: 'a',
        balance: { trialImagesUsed: 2, purchasedCredits: 10, totalGrantedCredits: 12, totalConsumedCredits: 6, totalRefundedCredits: 0 },
        statistics: { totalImagesGenerated: 8, totalGenerationRequests: 5, totalFailedRequests: 1, modelUsageCounts: { 'gpt-image-2': 5, 'gemini-3': 3 } },
      }),
      makeUser({
        userId: 'b',
        balance: { trialImagesUsed: 1, purchasedCredits: 4, totalGrantedCredits: 4, totalConsumedCredits: 2, totalRefundedCredits: 0 },
        statistics: { totalImagesGenerated: 2, totalGenerationRequests: 3, totalFailedRequests: 2, modelUsageCounts: { 'gpt-image-2': 2 } },
      }),
    ])

    expect(stats.totals.users).toBe(2)
    expect(stats.totals.totalRequests).toBe(8)
    expect(stats.totals.totalImages).toBe(10)
    expect(stats.totals.totalFailed).toBe(3)
    expect(stats.totals.successRate).toBeCloseTo(5 / 8)
    expect(stats.totals.totalConsumedCredits).toBe(8)
    expect(stats.totals.purchasedBalance).toBe(14)
    expect(stats.totals.trialImagesUsed).toBe(3)

    expect(stats.modelRows).toEqual([
      { modelId: 'gpt-image-2', images: 7, percent: '70.0%' },
      { modelId: 'gemini-3', images: 3, percent: '30.0%' },
    ])
    expect(stats.topModel).toBe('gpt-image-2')
  })

  test('user rows are sorted by images then requests and capped by limit', () => {
    const users = Array.from({ length: 25 }, (_, i) => makeUser({
      userId: `u${i}`,
      statistics: { totalImagesGenerated: i, totalGenerationRequests: i, totalFailedRequests: 0, modelUsageCounts: {} },
    }))
    const stats = buildOverviewStats(users)
    expect(stats.userRows).toHaveLength(20)
    expect(stats.userRows[0].userId).toBe('u24')
    expect(stats.userRows[19].userId).toBe('u5')
  })

  test('defensive: malformed statistics and balance do not throw', () => {
    const stats = buildOverviewStats([
      makeUser({ statistics: undefined as any, balance: undefined as any }),
      makeUser({ statistics: { modelUsageCounts: 'bad' } as any }),
    ])
    expect(stats.totals.totalRequests).toBe(0)
    expect(stats.totals.totalImages).toBe(0)
    expect(stats.modelRows).toEqual([])
  })
})
