import { describe, expect, test } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserManager } from '../src/services/UserManager.js'
import type { Config } from '../src/shared/config.js'

const logger = { info() {}, warn() {}, error() {}, debug() {} } as any

const cfg: Config = {
  trialImageLimit: 0,
  creditUnitName: '积分',
  rateLimitWindow: 60,
  rateLimitMax: 20,
  adminUsers: [],
  permanentMembers: [],
  modelWhitelistUsers: [],
  freePlatforms: [],
  modelMappings: [],
} as unknown as Config

async function manager() {
  const dir = await mkdtemp(join(tmpdir(), 'ranking-'))
  return { u: new UserManager(dir, logger), dir }
}

describe('UserManager.getModelUsageStats', () => {
  test('returns zeros when no users have generated images', async () => {
    const { u } = await manager()
    const stats = await u.getModelUsageStats()
    expect(stats).toEqual({ totalRequests: 0, totalImages: 0, modelCounts: {}, topModel: null })
    u.dispose()
  })

  test('records per-model counts after recordUsageOnly with modelId', async () => {
    const { u } = await manager()
    await u.recordUsageOnly('u1', 'U1', 'style-a', 3, cfg, 'model-a')
    await u.recordUsageOnly('u1', 'U1', 'style-b', 2, cfg, 'model-b')
    await u.recordUsageOnly('u1', 'U1', 'style-a', 4, cfg, 'model-a')
    const stats = await u.getModelUsageStats()
    expect(stats.totalRequests).toBe(3)
    expect(stats.totalImages).toBe(9)
    expect(stats.modelCounts).toEqual({ 'model-a': 7, 'model-b': 2 })
    expect(stats.topModel).toBe('model-a')
    u.dispose()
  })

  test('aggregates counts across multiple users', async () => {
    const { u } = await manager()
    await u.recordUsageOnly('u1', 'U1', 'style-a', 5, cfg, 'model-a')
    await u.recordUsageOnly('u2', 'U2', 'style-a', 3, cfg, 'model-a')
    await u.recordUsageOnly('u2', 'U2', 'style-b', 6, cfg, 'model-b')
    await u.recordUsageOnly('u3', 'U3', 'style-c', 1, cfg, 'model-c')
    const stats = await u.getModelUsageStats()
    expect(stats.totalRequests).toBe(4)
    expect(stats.totalImages).toBe(15)
    expect(stats.modelCounts).toEqual({ 'model-a': 8, 'model-b': 6, 'model-c': 1 })
    expect(stats.topModel).toBe('model-a')
    u.dispose()
  })

  test('identifies the correct top model when a later-added model overtakes', async () => {
    const { u } = await manager()
    await u.recordUsageOnly('u1', 'U1', 'style-a', 3, cfg, 'model-a')
    await u.recordUsageOnly('u1', 'U1', 'style-b', 10, cfg, 'model-b')
    const stats = await u.getModelUsageStats()
    expect(stats.topModel).toBe('model-b')
    expect(stats.modelCounts['model-b']).toBe(10)
    u.dispose()
  })

  test('backward compatibility: legacy users without modelUsageCounts still aggregate', async () => {
    const { u, dir } = await manager()
    // Seed a users.v2.json without modelUsageCounts to simulate a store written before 1.2.3
    const now = new Date().toISOString()
    const store = {
      schemaVersion: 2,
      createdAt: now,
      updatedAt: now,
      users: {
        legacy: {
          userId: 'legacy',
          userName: 'Legacy',
          createdAt: now,
          updatedAt: now,
          balance: {
            trialImagesUsed: 0,
            trialDate: now.slice(0, 10),
            purchasedCredits: 0,
            totalGrantedCredits: 0,
            totalConsumedCredits: 0,
            totalRefundedCredits: 0,
          },
          statistics: {
            totalImagesGenerated: 7,
            totalGenerationRequests: 4,
            totalFailedRequests: 0,
          },
          flags: {},
        },
      },
      reservations: {},
      metadata: { plugin: 'aka-ai-image-generator', billingUnit: 'credit', lastLedgerSequence: 0 },
    }
    await writeFile(join(dir, 'users.v2.json'), JSON.stringify(store, null, 2), 'utf-8')

    const legacyUser = await u.getUserData('legacy', 'Legacy', cfg)
    // ensureStatisticsShape should have injected an empty modelUsageCounts
    expect(legacyUser.statistics.modelUsageCounts).toEqual({})

    // Aggregation must still include legacy totals without crashing
    const stats = await u.getModelUsageStats()
    expect(stats.totalRequests).toBe(4)
    expect(stats.totalImages).toBe(7)
    expect(stats.modelCounts).toEqual({})
    expect(stats.topModel).toBe(null)

    // Adding a new usage with modelId works after backfill
    await u.recordUsageOnly('legacy', 'Legacy', 'style-x', 2, cfg, 'model-x')
    const after = await u.getModelUsageStats()
    expect(after.modelCounts).toEqual({ 'model-x': 2 })
    expect(after.topModel).toBe('model-x')
    u.dispose()
  })

  test('recordUsageOnly without modelId does not create empty model entry', async () => {
    const { u } = await manager()
    await u.recordUsageOnly('u1', 'U1', 'style-a', 2, cfg)
    const stats = await u.getModelUsageStats()
    expect(stats.totalImages).toBe(2)
    expect(stats.totalRequests).toBe(1)
    expect(stats.modelCounts).toEqual({})
    expect(stats.topModel).toBe(null)
    u.dispose()
  })
})
