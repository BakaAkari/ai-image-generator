import { describe, expect, test, afterEach, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserManager } from '../src/services/UserManager.js'
import type { Config } from '../src/shared/config.js'

const logger = { info() {}, warn() {}, error() {}, debug() {} } as any

const baseCfg: Config = {
  trialImageLimit: 0,
  creditUnitName: '积分',
  rateLimitWindow: 60,
  rateLimitMax: 3,
  adminUsers: [],
  permanentMembers: [],
} as unknown as Config

async function manager() {
  const dir = await mkdtemp(join(tmpdir(), 'ratelimit-'))
  return new UserManager(dir, logger)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('UserManager.checkRateLimit', () => {
  test('allows up to N requests within the window and blocks the (N+1)th', async () => {
    const u = await manager()
    for (let i = 0; i < baseCfg.rateLimitMax; i++) {
      const check = u.checkRateLimit('user-a', baseCfg)
      expect(check.allowed).toBe(true)
      u.updateRateLimit('user-a')
    }
    const blocked = u.checkRateLimit('user-a', baseCfg)
    expect(blocked.allowed).toBe(false)
    expect(blocked.message).toBeDefined()
    u.dispose()
  })

  test('after the window advances, requests are allowed again', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const u = await manager()

    for (let i = 0; i < baseCfg.rateLimitMax; i++) {
      expect(u.checkRateLimit('user-b', baseCfg).allowed).toBe(true)
      u.updateRateLimit('user-b')
    }
    expect(u.checkRateLimit('user-b', baseCfg).allowed).toBe(false)

    // Advance well past the rate-limit window; stale timestamps are pruned on check.
    vi.setSystemTime(new Date('2026-01-01T00:02:00Z'))
    expect(u.checkRateLimit('user-b', baseCfg).allowed).toBe(true)
    u.dispose()
  })

  test('separate users have independent rate-limit counters', async () => {
    const u = await manager()
    for (let i = 0; i < baseCfg.rateLimitMax; i++) {
      u.updateRateLimit('user-c')
    }
    expect(u.checkRateLimit('user-c', baseCfg).allowed).toBe(false)
    expect(u.checkRateLimit('user-d', baseCfg).allowed).toBe(true)
    u.dispose()
  })
})
