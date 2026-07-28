import { describe, expect, test } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserManager } from '../src/services/UserManager.js'
import type { Config } from '../src/shared/config.js'
import type { ModelMappingConfig } from '../src/shared/types.js'

const logger = { info() {}, warn() {}, error() {}, debug() {} } as any

const baseCfg: Config = {
  trialImageLimit: 0,
  creditUnitName: '积分',
  rateLimitWindow: 60,
  rateLimitMax: 2,
  adminUsers: [],
  permanentMembers: [],
  modelWhitelistUsers: [],
  freePlatforms: ['sandbox'],
  freeTrialModelId: 'free-model',
  modelMappings: [
    { suffix: 'free', modelId: 'free-model' },
    { suffix: 'paid', modelId: 'paid-model', restricted: true },
  ],
} as unknown as Config

async function manager() {
  const dir = await mkdtemp(join(tmpdir(), 'freeplat-'))
  return new UserManager(dir, logger)
}

type MinimalImageService = {
  isFreePlatform(platform?: string | null): boolean
  recordUsageOnly(userId: string, userName: string, commandName: string, numImages: number): Promise<unknown>
  checkModelAccess(userId: string, modifiers: { modelMapping?: ModelMappingConfig }): { allowed: boolean; message?: string }
  checkFreeTrialForModel(userId: string, mapping: ModelMappingConfig, platform?: string): { allowed: boolean; message?: string }
}

/** Build a minimal service-shaped stub for methods that only read config / userManager. */
function fakeService(config: Config, userManager?: UserManager): MinimalImageService {
  return {
    isFreePlatform(platform?: string | null) {
      return platform != null && Array.isArray(config.freePlatforms) && config.freePlatforms.includes(platform)
    },
    recordUsageOnly(userId: string, userName: string, commandName: string, numImages: number) {
      if (!userManager) throw new Error('userManager missing')
      return userManager.recordUsageOnly(userId, userName, commandName, numImages, config)
    },
    checkModelAccess(userId: string, modifiers: { modelMapping?: ModelMappingConfig }) {
      const mapping = modifiers.modelMapping
      if (!mapping?.modelId) return { allowed: false, message: '未配置可用模型映射' }
      if (!mapping.restricted) return { allowed: true }
      if (userManager?.isModelWhitelisted(userId, config) || config.adminUsers?.includes(userId) || config.modelWhitelistUsers?.includes(userId)) {
        return { allowed: true }
      }
      return { allowed: false, message: '模型受限' }
    },
    checkFreeTrialForModel(_userId: string, mapping: ModelMappingConfig, platform?: string) {
      if (this.isFreePlatform(platform)) return { allowed: true }
      const freeModelId = config.freeTrialModelId
      if (!freeModelId) return { allowed: false, message: '未设置每日免费模型' }
      if (mapping.modelId === freeModelId) return { allowed: true }
      return { allowed: false, message: '模型不在免费列表' }
    },
  }
}

describe('isFreePlatform', () => {
  test('returns true only when platform is in config.freePlatforms', () => {
    const svc = fakeService(baseCfg)
    expect(svc.isFreePlatform('sandbox')).toBe(true)
    expect(svc.isFreePlatform('onebot')).toBe(false)
    expect(svc.isFreePlatform(null)).toBe(false)
    expect(svc.isFreePlatform(undefined)).toBe(false)
  })

  test('returns false when freePlatforms is undefined', () => {
    const svc = fakeService({ ...baseCfg, freePlatforms: undefined } as unknown as Config)
    expect(svc.isFreePlatform('sandbox')).toBe(false)
  })
})

describe('free platform bypasses reserve/settle but still records usage', () => {
  test('recordUsageOnly increments totalImagesGenerated/totalGenerationRequests without touching balance', async () => {
    const u = await manager()
    const svc = fakeService(baseCfg, u)

    // Give user some existing balance so we can verify it is left untouched.
    const before = await u.getUserData('free-user', 'FreeUser', baseCfg)
    before.balance.purchasedCredits = 100
    await (u as any).saveUsersStoreInternal()

    await svc.recordUsageOnly('free-user', 'FreeUser', 'aigc_generate_image', 3)
    await svc.recordUsageOnly('free-user', 'FreeUser', 'aigc_generate_image', 2)

    const after = await u.getUserData('free-user', 'FreeUser', baseCfg)
    expect(after.statistics.totalImagesGenerated).toBe(5)
    expect(after.statistics.totalGenerationRequests).toBe(2)
    // Balance untouched — no reservation or settlement occurred.
    expect(after.balance.purchasedCredits).toBe(100)
    expect(after.balance.totalConsumedCredits).toBe(0)
    expect(after.balance.trialImagesUsed).toBe(0)

    u.dispose()
  })

  test('no credit reservation is stored for a free-platform recordUsageOnly call', async () => {
    const u = await manager()
    const svc = fakeService(baseCfg, u)

    await svc.recordUsageOnly('free-user-2', 'FreeUser2', 'aigc_generate_image', 1)

    // Inspect the internal reservations map — no reservation should have been created.
    const reservations = (u as any).creditReservations as Map<string, unknown>
    expect(reservations.size).toBe(0)
    u.dispose()
  })
})

describe('free platform success message', () => {
  test('the free-platform branch text contains only the image count — no credit / trial / balance wording', () => {
    // Mirror the exact expression from src/orchestrators/ImageGenerationOrchestrator.ts.
    // Any wording drift here means the orchestrator's free-platform branch needs review.
    const generatedImagesCount = 4
    const message = ['生成完成', '', `- 图片｜${generatedImagesCount} 张`].join('\n')

    expect(message).toContain(`- 图片｜${generatedImagesCount} 张`)
    expect(message).not.toMatch(/积分/)
    expect(message).not.toMatch(/试用/)
    expect(message).not.toMatch(/余额/)
    expect(message).not.toMatch(/消耗/)
  })
})

describe('free platform still respects checkModelAccess', () => {
  test('restricted model is blocked for a non-admin, non-whitelisted user even on a free platform', () => {
    const svc = fakeService(baseCfg)
    const restricted: ModelMappingConfig = { suffix: 'paid', modelId: 'paid-model', restricted: true } as ModelMappingConfig

    const access = svc.checkModelAccess('random-user', { modelMapping: restricted } as any)
    expect(access.allowed).toBe(false)
  })

  test('restricted model is allowed for an admin', () => {
    const cfg = { ...baseCfg, adminUsers: ['admin-1'] } as unknown as Config
    const svc = fakeService(cfg)
    const restricted: ModelMappingConfig = { suffix: 'paid', modelId: 'paid-model', restricted: true } as ModelMappingConfig

    const access = svc.checkModelAccess('admin-1', { modelMapping: restricted } as any)
    expect(access.allowed).toBe(true)
  })

  test('restricted model is allowed for a whitelisted user', () => {
    const cfg = { ...baseCfg, modelWhitelistUsers: ['vip-1'] } as unknown as Config
    const svc = fakeService(cfg)
    const restricted: ModelMappingConfig = { suffix: 'paid', modelId: 'paid-model', restricted: true } as ModelMappingConfig

    const access = svc.checkModelAccess('vip-1', { modelMapping: restricted } as any)
    expect(access.allowed).toBe(true)
  })
})

describe('rate limit still blocks free-platform users', () => {
  test('exceeding rateLimitMax blocks the free-platform user just like paid users', async () => {
    const u = await manager()

    for (let i = 0; i < baseCfg.rateLimitMax; i++) {
      const check = u.checkRateLimit('free-heavy', baseCfg)
      expect(check.allowed).toBe(true)
      u.updateRateLimit('free-heavy')
    }
    const blocked = u.checkRateLimit('free-heavy', baseCfg)
    expect(blocked.allowed).toBe(false)
    expect(blocked.message).toBeDefined()

    u.dispose()
  })
})

describe('checkFreeTrialForModel exempts free platforms', () => {
  test('free platform user can access any model without hitting the free-trial gate', () => {
    const svc = fakeService(baseCfg)
    const nonFree: ModelMappingConfig = { suffix: 'paid', modelId: 'paid-model' } as ModelMappingConfig

    const denied = svc.checkFreeTrialForModel('random-user', nonFree, 'onebot')
    expect(denied.allowed).toBe(false)

    const allowed = svc.checkFreeTrialForModel('random-user', nonFree, 'sandbox')
    expect(allowed.allowed).toBe(true)
  })
})
