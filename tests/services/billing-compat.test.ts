/**
 * 计费兼容性修复（1.3.6）回归：
 * - checkFreeTrialForModel 余额感知：有购买余额放行任意模型，无余额仅放行每日免费模型。
 * - normalizeStore 旧版（积分制）计费字段迁移：trialImagesUsed/trialDate 补全与单位保守换算。
 * - getTrialRemaining 对缺失 trialImagesUsed 的 NaN 防御（经迁移层间接覆盖）。
 */
import { describe, expect, test, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('koishi', () => ({
  Service: class { constructor() {} },
  Context: class {},
  Schema: class {},
}))

import { UserManager } from '../../src/services/UserManager.js'
import { AiImageGeneratorService } from '../../src/service/AiImageGeneratorService.js'
import type { Config } from '../../src/shared/config.js'

const TODAY = new Date().toISOString().slice(0, 10)

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any
}

// ─── checkFreeTrialForModel（余额感知） ──────────────────────────────────────

function serviceWith(userManager: any, pluginConfig: Partial<Config>) {
  // 绕过重构造：方法只依赖 userManager / pluginConfig / pluginLogger
  const service = Object.create(AiImageGeneratorService.prototype)
  service.userManager = userManager
  service.pluginConfig = pluginConfig
  service.pluginLogger = makeLogger()
  return service as AiImageGeneratorService
}

const paidMapping = { suffix: '-paid', modelId: 'gpt-image-2' } as any
const freeMapping = { suffix: '-free', modelId: 'gpt-image-1' } as any

describe('checkFreeTrialForModel（余额感知）', () => {
  const baseConfig = {
    adminUsers: [],
    permanentMembers: [],
    freePlatforms: [],
    freeTrialModelId: 'gpt-image-1',
  } as unknown as Config

  test('有购买余额 → 放行非免费模型', async () => {
    const um = {
      isAdmin: () => false,
      isPermanentMember: () => false,
      getExistingUserData: async () => ({ balance: { purchasedCredits: 3900 } }),
    }
    const service = serviceWith(um, baseConfig)
    const res = await service.checkFreeTrialForModel('u1', paidMapping, 'onebot')
    expect(res.allowed).toBe(true)
  })

  test('无购买余额 + 非免费模型 → 拦截，文案提示充值', async () => {
    const um = {
      isAdmin: () => false,
      isPermanentMember: () => false,
      getExistingUserData: async () => ({ balance: { purchasedCredits: 0 } }),
    }
    const service = serviceWith(um, baseConfig)
    const res = await service.checkFreeTrialForModel('u1', paidMapping, 'onebot')
    expect(res.allowed).toBe(false)
    expect(res.message).toContain('模型不在免费列表')
  })

  test('无购买余额 + 每日免费模型 → 放行', async () => {
    const um = {
      isAdmin: () => false,
      isPermanentMember: () => false,
      getExistingUserData: async () => undefined,
    }
    const service = serviceWith(um, baseConfig)
    const res = await service.checkFreeTrialForModel('u1', freeMapping, 'onebot')
    expect(res.allowed).toBe(true)
  })

  test('豁免用户（管理员）→ 放行，不查余额', async () => {
    const getExistingUserData = vi.fn()
    const um = { isAdmin: () => true, isPermanentMember: () => false, getExistingUserData }
    const service = serviceWith(um, { ...baseConfig, adminUsers: ['u1'] } as Config)
    const res = await service.checkFreeTrialForModel('u1', paidMapping, 'onebot')
    expect(res.allowed).toBe(true)
    expect(getExistingUserData).not.toHaveBeenCalled()
  })

  test('余额读取异常 → 按无余额处理，不崩溃', async () => {
    const um = {
      isAdmin: () => false,
      isPermanentMember: () => false,
      getExistingUserData: async () => { throw new Error('io error') },
    }
    const service = serviceWith(um, baseConfig)
    const res = await service.checkFreeTrialForModel('u1', paidMapping, 'onebot')
    expect(res.allowed).toBe(false)
  })
})

// ─── 旧版用户数据迁移 ────────────────────────────────────────────────────────

async function writeStore(dir: string, store: any) {
  await writeFile(join(dir, 'users.v2.json'), JSON.stringify(store, null, 2), 'utf-8')
}

function legacyBalance(overrides: Record<string, unknown> = {}) {
  return {
    dailyFreeCreditsUsed: 0,
    dailyFreeCreditsLimitSnapshot: 50,
    dailyResetDate: TODAY,
    purchasedCredits: 3900,
    totalGrantedCredits: 4000,
    totalConsumedCredits: 100,
    totalRefundedCredits: 0,
    ...overrides,
  }
}

function storeWith(users: Record<string, any>) {
  return { schemaVersion: 2, createdAt: TODAY, updatedAt: TODAY, users }
}

describe('normalizeStore 旧版计费字段迁移', () => {
  test('中间版记录：积分字段无损继承，新字段补全（当天未用免费额度 → 0）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mig-'))
    await writeStore(dir, storeWith({
      u1: { userId: 'u1', userName: 'U', balance: legacyBalance(), statistics: {}, flags: {} },
    }))
    const um = new UserManager(dir, makeLogger())
    const user = await um.getExistingUserData('u1')

    expect(user!.balance.purchasedCredits).toBe(3900)
    expect(user!.balance.totalGrantedCredits).toBe(4000)
    expect(user!.balance.trialImagesUsed).toBe(0)
    expect(user!.balance.trialDate).toBe(TODAY) // 继承旧 dailyResetDate
    um.dispose()
  })

  test('中间版记录：当天已用免费额度 → 视为当天额度已用完', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mig-'))
    await writeStore(dir, storeWith({
      u1: { userId: 'u1', userName: 'U', balance: legacyBalance({ dailyFreeCreditsUsed: 50 }), statistics: {}, flags: {} },
    }))
    const um = new UserManager(dir, makeLogger())
    const user = await um.getExistingUserData('u1')

    expect(user!.balance.trialImagesUsed).toBe(Number.MAX_SAFE_INTEGER)
    um.dispose()
  })

  test('旧日期记录：trialDate 继承旧日期，下次试用判断时按日重置', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mig-'))
    await writeStore(dir, storeWith({
      u1: { userId: 'u1', userName: 'U', balance: legacyBalance({ dailyResetDate: '2026-07-01', dailyFreeCreditsUsed: 50 }), statistics: {}, flags: {} },
    }))
    const um = new UserManager(dir, makeLogger())
    const user = await um.getExistingUserData('u1')

    // 迁移不新增额度：trialImagesUsed 从 0 开始；trialDate 保留旧日期，
    // getTrialRemaining 发现非今天会重置（语义与「新的一天」一致）
    expect(user!.balance.trialImagesUsed).toBe(0)
    expect(user!.balance.trialDate).toBe('2026-07-01')
    um.dispose()
  })

  test('已是新结构的记录：幂等，不被改写', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mig-'))
    await writeStore(dir, storeWith({
      u1: {
        userId: 'u1', userName: 'U',
        balance: {
          trialImagesUsed: 2, trialDate: TODAY,
          purchasedCredits: 15, totalGrantedCredits: 15,
          totalConsumedCredits: 386.19, totalRefundedCredits: 0,
        },
        statistics: {}, flags: {},
      },
    }))
    const um = new UserManager(dir, makeLogger())
    const user = await um.getExistingUserData('u1')

    expect(user!.balance.trialImagesUsed).toBe(2)
    expect(user!.balance.purchasedCredits).toBe(15)
    um.dispose()
  })

  test('迁移后试用流程可用：余额与试用判断不触发 NaN', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mig-'))
    await writeStore(dir, storeWith({
      u1: { userId: 'u1', userName: 'U', balance: legacyBalance({ purchasedCredits: 0 }), statistics: {}, flags: {} },
    }))
    const um = new UserManager(dir, makeLogger())
    const cfg = {
      trialImageLimit: 3, creditUnitName: '积分', rateLimitWindow: 300, rateLimitMax: 20,
      adminUsers: [], permanentMembers: [],
    } as unknown as Config
    const res = await um.reserveCredits(
      'u1', 'U', 'r1',
      { totalCredits: 4, creditCostPerImage: 1, numImages: 4, modelId: 'gpt-image-1', costSource: 'model-fixed' },
      cfg, 'onebot', true,
    )
    expect(res.allowed).toBe(true)
    expect(res.isTrial).toBe(true)
    um.dispose()
  })

  test('非 schemaVersion 2 格式：告警并重置为空 store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mig-'))
    const logger = makeLogger()
    await writeStore(dir, { u1: { userId: 'u1', balance: legacyBalance() } }) // 平铺旧格式
    const um = new UserManager(dir, logger)
    const user = await um.getExistingUserData('u1')

    expect(user).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('格式异常'),
      expect.anything(),
    )
    um.dispose()
  })
})
