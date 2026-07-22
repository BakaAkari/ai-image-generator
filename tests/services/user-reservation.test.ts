import { describe, expect, test } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserManager } from '../../src/services/UserManager.js'
import type { Config } from '../../src/shared/config.js'
import type { GenerationCost } from '../../src/shared/billing.js'

const logger = { info() {}, warn() {}, error() {}, debug() {} }
const config = {
  dailyFreeCredits: 5,
  creditUnitName: '积分',
  rateLimitWindow: 300,
  rateLimitMax: 20,
  adminUsers: [],
  permanentMembers: [],
  unlimitedPlatforms: [],
} as unknown as Config

function cost(totalCredits: number, numImages = 4): GenerationCost {
  return { totalCredits, creditCostPerImage: totalCredits / numImages, numImages, modelId: 'm', costSource: 'model-fixed' }
}

async function manager() {
  const dir = await mkdtemp(join(tmpdir(), 'reservation-'))
  return new UserManager(dir, logger)
}

describe('UserManager credit reservations', () => {
  test('concurrent reservations cannot overspend the same balance', async () => {
    const users = await manager()
    const [a, b] = await Promise.all([
      users.reserveCredits('u1', 'User', 'r1', cost(4), config),
      users.reserveCredits('u1', 'User', 'r2', cost(4), config),
    ])
    expect([a.allowed, b.allowed].filter(Boolean)).toHaveLength(1)
    users.dispose()
  })

  test('partial settlement conserves reserved = settled + released', async () => {
    const users = await manager()
    const reserved = await users.reserveCredits('u1', 'User', 'r1', cost(4, 4), config)
    expect(reserved.allowed).toBe(true)
    const result = await users.settleReservation('r1', 2, '生成', config, { routeId: 'openai:text-to-image' })
    expect(result).toMatchObject({ reservedCredits: 4, settledCredits: 2, releasedCredits: 2, actualImages: 2 })
    expect(result.reservedCredits).toBe(result.settledCredits + result.releasedCredits)
    const summary = users.buildCreditSummary(await users.getUserData('u1', 'User', config), config)
    expect(summary.totalAvailable).toBe(3)
    expect(summary.totalConsumedCredits).toBe(2)
    users.dispose()
  })

  test('release restores the full reservation and is idempotent', async () => {
    const users = await manager()
    await users.reserveCredits('u1', 'User', 'r1', cost(4), config)
    const first = await users.releaseReservation('r1', config, 'provider failed')
    const second = await users.releaseReservation('r1', config, 'duplicate release')
    expect(second).toEqual(first)
    expect(first).toMatchObject({ settledCredits: 0, releasedCredits: 4 })
    const summary = users.buildCreditSummary(await users.getUserData('u1', 'User', config), config)
    expect(summary.totalAvailable).toBe(5)
    users.dispose()
  })



  test('a reservation survives manager restart and can be released', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reservation-'))
    const first = new UserManager(dir, logger)
    await first.reserveCredits('u1', 'User', 'r1', cost(4), config)
    first.dispose()

    const second = new UserManager(dir, logger)
    const released = await second.releaseReservation('r1', config, 'restart recovery')
    expect(released).toMatchObject({ releasedCredits: 4, status: 'released' })
    const summary = second.buildCreditSummary(await second.getUserData('u1', 'User', config), config)
    expect(summary.totalAvailable).toBe(5)
    second.dispose()
  })


  test('expired active reservations are reconciled and released after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reservation-'))
    const first = new UserManager(dir, logger)
    await first.reserveCredits('u1', 'User', 'r1', cost(4), config)
    first.dispose()
    const file = join(dir, 'credit-reservations.v1.json')
    const stored = JSON.parse(await readFile(file, 'utf8'))
    stored.reservations[0].expiresAt = 0
    await writeFile(file, JSON.stringify(stored), 'utf8')

    const second = new UserManager(dir, logger)
    const reconciled = await second.reconcileExpiredReservations(config)
    expect(reconciled).toBe(1)
    const summary = second.buildCreditSummary(await second.getUserData('u1', 'User', config), config)
    expect(summary.totalAvailable).toBe(5)
    second.dispose()
  })

  test('exempt users settle without debit but preserve settlement evidence', async () => {
    const users = await manager()
    const exemptConfig = { ...config, adminUsers: ['u1'] } as Config
    const reserved = await users.reserveCredits('u1', 'User', 'r1', cost(4), exemptConfig)
    expect(reserved.allowed).toBe(true)
    const result = await users.settleReservation('r1', 2, '生成', exemptConfig, { exemption: 'admin' })
    expect(result).toMatchObject({ reservedCredits: 0, settledCredits: 0, releasedCredits: 0, actualImages: 2 })
    const summary = users.buildCreditSummary(await users.getUserData('u1', 'User', exemptConfig), exemptConfig)
    expect(summary.totalAvailable).toBe(5)
    expect(summary.totalImagesGenerated).toBe(2)
    users.dispose()
  })


  test('platform-exempt reservation records delivery without debit', async () => {
    const users = await manager()
    const platformConfig = { ...config, unlimitedPlatforms: ['lark'] } as Config
    await users.reserveCredits('u1', 'User', 'r1', cost(4), platformConfig, 'lark')
    const result = await users.settleReservation('r1', 1, '生成', platformConfig, { exemption: 'platform' })
    expect(result.settledCredits).toBe(0)
    expect((await users.getUserData('u1', 'User', platformConfig)).statistics.totalImagesGenerated).toBe(1)
    users.dispose()
  })

  test('repeated settlement is idempotent', async () => {
    const users = await manager()
    await users.reserveCredits('u1', 'User', 'r1', cost(4), config)
    const first = await users.settleReservation('r1', 3, '生成', config, null)
    const second = await users.settleReservation('r1', 3, '生成', config, null)
    expect(second).toEqual(first)
    users.dispose()
  })
})
