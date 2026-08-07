import { describe, expect, test } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserManager } from '../../src/services/UserManager.js'
import type { Config } from '../../src/shared/config.js'
import type { GenerationCost } from '../../src/shared/billing.js'

const logger = { info() {}, warn() {}, error() {}, debug() {} } as any

const paidCfg: Config = {
  trialImageLimit: 0,
  creditUnitName: '积分', rateLimitWindow: 300, rateLimitMax: 20,
  adminUsers: [], permanentMembers: [],
} as unknown as Config

const trialCfg: Config = { ...paidCfg, trialImageLimit: 3 } as unknown as Config
const adminCfg: Config = { ...paidCfg, adminUsers: ['admin1'] } as unknown as Config

function cost(totalCredits: number, numImages = 4): GenerationCost {
  return { totalCredits, creditCostPerImage: totalCredits / numImages, numImages, modelId: 'm', costSource: 'model-fixed' }
}

async function manager() {
  const dir = await mkdtemp(join(tmpdir(), 'resv-'))
  return new UserManager(dir, logger)
}

// Helper: give a user purchased credits by directly setting balance
async function fundUser(users: UserManager, userId: string, userName: string, amount: number) {
  const user = await users.getUserData(userId, userName, adminCfg)
  user.balance.purchasedCredits = amount
  await (users as any).saveUsersStoreInternal()
}

describe('UserManager', () => {
  test('paid: reserve then partial settle', async () => {
    const u = await manager()
    await fundUser(u, 'u1', 'U', 10)
    const res = await u.reserveCredits('u1', 'U', 'r1', cost(4, 4), paidCfg)
    expect(res.allowed).toBe(true)
    const result = await u.settleReservation('r1', 2, 'gen', paidCfg, { actualCost: 1 })
    expect(result).toMatchObject({ reservedCredits: 4, settledCredits: 2, releasedCredits: 2, actualImages: 2 })
    u.dispose()
  })

  test('paid: release restores balance', async () => {
    const u = await manager()
    await fundUser(u, 'u1', 'U', 5)
    await u.reserveCredits('u1', 'U', 'r1', cost(4), paidCfg)
    const r = await u.releaseReservation('r1', paidCfg, 'fail')
    expect(r).toMatchObject({ settledCredits: 0, releasedCredits: 4 })
    u.dispose()
  })

  test('paid: concurrent cannot overspend', async () => {
    const u = await manager()
    await fundUser(u, 'u1', 'U', 5)
    const [a, b] = await Promise.all([
      u.reserveCredits('u1', 'U', 'r1', cost(4), paidCfg),
      u.reserveCredits('u1', 'U', 'r2', cost(4), paidCfg),
    ])
    expect([a.allowed, b.allowed].filter(Boolean)).toHaveLength(1)
    u.dispose()
  })

  test('paid: idempotent settlement', async () => {
    const u = await manager()
    await fundUser(u, 'u1', 'U', 5)
    await u.reserveCredits('u1', 'U', 'r1', cost(4), paidCfg)
    const first = await u.settleReservation('r1', 3, 'gen', paidCfg, { actualCost: 1 })
    const second = await u.settleReservation('r1', 3, 'gen', paidCfg, { actualCost: 1 })
    expect(second).toEqual(first)
    u.dispose()
  })

  test('trial: skip credit consumption, increment counter', async () => {
    const u = await manager()
    const res = await u.reserveCredits('u3', 'U', 'r1', cost(4), trialCfg, undefined, true)
    expect(res.allowed).toBe(true)
    expect(res.isTrial).toBe(true)
    const result = await u.settleReservation('r1', 1, 'gen', trialCfg, { actualCost: 1.5 })
    expect(result.settledCredits).toBe(0)
    const user = await u.getUserData('u3', 'U', trialCfg)
    expect(user.balance.trialImagesUsed).toBe(1)
    u.dispose()
  })

  test('admin: bypass balance check (reservedCredits=0 → cap skipped, settledCredits reflects actual)', async () => {
    // 管理员豁免路径 reservedCredits=0，封顶逻辑跳过，settledCredits 按 actualCost 记账（豁免语义保持）
    const u = await manager()
    const res = await u.reserveCredits('admin1', 'A', 'r1', cost(100), adminCfg)
    expect(res.allowed).toBe(true)
    const result = await u.settleReservation('r1', 1, 'gen', adminCfg, { actualCost: 5 })
    expect(result.settledCredits).toBe(5)
    u.dispose()
  })

  test('paid: settlement cap prevents balance from going negative (overrun logged)', async () => {
    // 预扣 4 积分，结算真实成本 10 积分（预扣不足）：应封顶到 reservedCredits=4，余额不变负
    const u = await manager()
    await fundUser(u, 'u1', 'U', 10)
    await u.reserveCredits('u1', 'U', 'r1', cost(4, 1), paidCfg)
    const before = await u.getUserData('u1', 'U', paidCfg)
    const beforePurchased = before.balance.purchasedCredits
    const result = await u.settleReservation('r1', 1, 'gen', paidCfg, { actualCost: 10 })
    expect(result.settledCredits).toBe(4)
    expect(result.releasedCredits).toBe(0)
    const after = await u.getUserData('u1', 'U', paidCfg)
    // 余额 = 之前 + released(0) = 之前，永不小于 0
    expect(after.balance.purchasedCredits).toBe(beforePurchased)
    expect(after.balance.purchasedCredits).toBeGreaterThanOrEqual(0)
    u.dispose()
  })

  test('paid: settlement 4dp precision keeps per-token micro-cost non-zero', async () => {
    // 结算真实成本 0.0026 积分（<0.01，两位取整会归零）；封顶后仍应保留 4dp 精度
    const u = await manager()
    await fundUser(u, 'u1', 'U', 10)
    await u.reserveCredits('u1', 'U', 'r1', cost(4, 1), paidCfg)
    const result = await u.settleReservation('r1', 1, 'gen', paidCfg, { actualCost: 0.0026 })
    expect(result.settledCredits).toBeCloseTo(0.0026, 4)
    expect(result.settledCredits).toBeGreaterThan(0)
    u.dispose()
  })
})
