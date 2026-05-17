import { existsSync, mkdirSync, promises as fs } from 'fs'
import { dirname, join } from 'path'
import type { Config } from '../shared/config.js'
import type { GenerationCost } from '../shared/billing.js'
import { roundCredits } from '../shared/billing.js'

class AsyncLock {
  private promise: Promise<void> = Promise.resolve()

  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    const previousPromise = this.promise
    let release: () => void
    const nextPromise = new Promise<void>((resolve) => {
      release = resolve
    })

    this.promise = nextPromise
    await previousPromise
    try {
      return await fn()
    } finally {
      release!()
    }
  }
}

export interface CreditBalanceV2 {
  dailyFreeCreditsUsed: number
  dailyFreeCreditsLimitSnapshot: number
  dailyResetDate: string
  purchasedCredits: number
  totalGrantedCredits: number
  totalConsumedCredits: number
  totalRefundedCredits: number
}

export interface UserStatisticsV2 {
  totalImagesGenerated: number
  totalGenerationRequests: number
  totalFailedRequests: number
  lastModelId?: string
  lastProvider?: string
}

export interface UserFlagsV2 {
  isBlocked?: boolean
  note?: string
}

export interface UserAccountV2 {
  userId: string
  userName: string
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
  balance: CreditBalanceV2
  statistics: UserStatisticsV2
  flags: UserFlagsV2
}

export interface UsersStoreV2 {
  schemaVersion: 2
  createdAt: string
  updatedAt: string
  users: Record<string, UserAccountV2>
  metadata: {
    plugin: 'aka-ai-image-generator'
    billingUnit: 'credit'
    lastLedgerSequence: number
  }
}

export interface CreditBalanceSnapshotV2 {
  dailyFreeRemaining: number
  purchasedCredits: number
  totalAvailable: number
  totalGrantedCredits: number
  totalConsumedCredits: number
  totalRefundedCredits: number
}

export interface CreditLedgerEventV2 {
  schemaVersion: 2
  sequence: number
  id: string
  timestamp: string
  userId: string
  userName: string
  type: 'grant' | 'consume' | 'refund' | 'adjust' | 'daily-reset' | 'migration'
  amount: number
  balanceBefore: CreditBalanceSnapshotV2
  balanceAfter: CreditBalanceSnapshotV2
  reason: string
  operator?: {
    userId: string
    userName: string
  }
  generation?: {
    commandName: string
    provider?: string
    modelId?: string
    modelSuffix?: string
    numImages: number
    creditCostPerImage: number
    totalCredits: number
    requestId?: string
  }
  metadata?: Record<string, unknown>
}

export interface RechargeRecordV2 {
  schemaVersion: 2
  id: string
  timestamp: string
  userId: string
  userName: string
  amount: number
  reason: string
  operator: {
    userId: string
    userName: string
  }
  externalPaymentNote?: string
  estimatedCny?: number
  ledgerSequence: number
}

export interface CreditSummary {
  userId: string
  userName: string
  dailyFreeRemaining: number
  purchasedCredits: number
  totalAvailable: number
  totalGrantedCredits: number
  totalConsumedCredits: number
  totalRefundedCredits: number
  totalImagesGenerated: number
  totalGenerationRequests: number
  lastUsedAt?: string
  estimatedCny?: number
}

export interface CreditConsumeResult {
  userData: UserAccountV2
  ledgerEvent?: CreditLedgerEventV2
  freeUsed: number
  purchasedUsed: number
  isExempt: boolean
}

export class UserManager {
  private dataDir: string
  private usersFile: string
  private usersBackupFile: string
  private ledgerFile: string
  private rechargeRecordsFile: string
  private snapshotsDir: string
  private logger: any
  private dataLock = new AsyncLock()
  private ledgerLock = new AsyncLock()

  private usersCache: UsersStoreV2 | null = null
  private activeTasks = new Map<string, { requestId: string; startedAt: number; expiresAt: number }>()
  private rateLimitMap = new Map<string, number[]>()
  private securityBlockMap = new Map<string, number[]>()
  private securityWarningMap = new Map<string, boolean>()

  constructor(baseDir: string, logger: any) {
    this.logger = logger
    this.dataDir = baseDir
    this.usersFile = join(this.dataDir, 'users.v2.json')
    this.usersBackupFile = join(this.dataDir, 'users.v2.json.backup')
    this.ledgerFile = join(this.dataDir, 'credit-ledger.v2.jsonl')
    this.rechargeRecordsFile = join(this.dataDir, 'recharge-records.v2.jsonl')
    this.snapshotsDir = join(this.dataDir, 'snapshots')

    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true })
    if (!existsSync(this.snapshotsDir)) mkdirSync(this.snapshotsDir, { recursive: true })
  }

  startTask(userId: string, ttlMs = 10 * 60 * 1000): string | undefined {
    this.cleanupExpiredTasks()
    if (this.activeTasks.has(userId)) return undefined

    const now = Date.now()
    const requestId = `${now}-${Math.random().toString(36).slice(2, 10)}`
    this.activeTasks.set(userId, {
      requestId,
      startedAt: now,
      expiresAt: now + Math.max(60 * 1000, ttlMs),
    })
    return requestId
  }

  endTask(userId: string, requestId?: string) {
    const task = this.activeTasks.get(userId)
    if (!task) return
    if (requestId && task.requestId !== requestId) return
    this.activeTasks.delete(userId)
  }

  isTaskActive(userId: string): boolean {
    this.cleanupExpiredTasks()
    return this.activeTasks.has(userId)
  }

  private cleanupExpiredTasks() {
    const now = Date.now()
    for (const [userId, task] of this.activeTasks) {
      if (task.expiresAt <= now) {
        this.logger.warn('清理过期图像任务锁', {
          userId,
          requestId: task.requestId,
          ageMs: now - task.startedAt,
        })
        this.activeTasks.delete(userId)
      }
    }
  }

  isAdmin(userId: string, config: Config): boolean {
    return !!(config.adminUsers && config.adminUsers.includes(userId))
  }

  isPermanentMember(userId: string, config: Config): boolean {
    return !!(config.permanentMembers && config.permanentMembers.includes(userId))
  }

  isModelWhitelisted(userId: string, config: Config): boolean {
    return this.isAdmin(userId, config) || !!(config.modelWhitelistUsers && config.modelWhitelistUsers.includes(userId))
  }

  private createEmptyStore(): UsersStoreV2 {
    const now = new Date().toISOString()
    return {
      schemaVersion: 2,
      createdAt: now,
      updatedAt: now,
      users: {},
      metadata: {
        plugin: 'aka-ai-image-generator',
        billingUnit: 'credit',
        lastLedgerSequence: 0,
      },
    }
  }

  private async loadUsersStore(): Promise<UsersStoreV2> {
    if (this.usersCache) return this.usersCache

    return await this.dataLock.acquire(async () => {
      if (this.usersCache) return this.usersCache

      try {
        if (existsSync(this.usersFile)) {
          const data = await fs.readFile(this.usersFile, 'utf-8')
          const parsed = JSON.parse(data)
          this.usersCache = this.normalizeStore(parsed)
          return this.usersCache
        }
      } catch (error) {
        this.logger.error('读取用户积分数据失败', error)
        if (existsSync(this.usersBackupFile)) {
          try {
            const backupData = await fs.readFile(this.usersBackupFile, 'utf-8')
            this.logger.warn('从备份文件恢复用户积分数据')
            this.usersCache = this.normalizeStore(JSON.parse(backupData))
            return this.usersCache
          } catch (backupError) {
            this.logger.error('用户积分备份文件也损坏，使用空数据', backupError)
          }
        }
      }

      this.usersCache = this.createEmptyStore()
      await this.saveUsersStoreInternal()
      return this.usersCache
    })
  }

  private normalizeStore(value: any): UsersStoreV2 {
    const now = new Date().toISOString()
    if (value?.schemaVersion === 2 && value.users && typeof value.users === 'object') {
      return {
        schemaVersion: 2,
        createdAt: value.createdAt || now,
        updatedAt: value.updatedAt || now,
        users: value.users,
        metadata: {
          plugin: 'aka-ai-image-generator',
          billingUnit: 'credit',
          lastLedgerSequence: Number(value.metadata?.lastLedgerSequence || 0),
        },
      }
    }
    return this.createEmptyStore()
  }

  private async saveUsersStoreInternal(): Promise<void> {
    if (!this.usersCache) return

    this.usersCache.updatedAt = new Date().toISOString()
    try {
      if (existsSync(this.usersFile)) {
        await fs.copyFile(this.usersFile, this.usersBackupFile)
      }
      await this.atomicWriteFile(this.usersFile, JSON.stringify(this.usersCache, null, 2))
    } catch (error) {
      this.logger.error('保存用户积分数据失败', error)
      throw error
    }
  }

  private async atomicWriteFile(path: string, content: string): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true })
    const tempFile = `${path}.tmp`
    await fs.writeFile(tempFile, content, 'utf-8')
    await fs.rename(tempFile, path)
  }

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10)
  }

  private createUserAccount(userId: string, userName: string, config?: Config): UserAccountV2 {
    const now = new Date().toISOString()
    return {
      userId,
      userName: userName || userId,
      createdAt: now,
      updatedAt: now,
      balance: {
        dailyFreeCreditsUsed: 0,
        dailyFreeCreditsLimitSnapshot: roundCredits(config?.dailyFreeCredits ?? 0),
        dailyResetDate: this.todayKey(),
        purchasedCredits: 0,
        totalGrantedCredits: 0,
        totalConsumedCredits: 0,
        totalRefundedCredits: 0,
      },
      statistics: {
        totalImagesGenerated: 0,
        totalGenerationRequests: 0,
        totalFailedRequests: 0,
      },
      flags: {},
    }
  }

  private ensureDailyReset(userData: UserAccountV2, config: Config): boolean {
    const today = this.todayKey()
    if (userData.balance.dailyResetDate === today) return false
    userData.balance.dailyResetDate = today
    userData.balance.dailyFreeCreditsUsed = 0
    userData.balance.dailyFreeCreditsLimitSnapshot = roundCredits(config.dailyFreeCredits ?? 0)
    userData.updatedAt = new Date().toISOString()
    return true
  }

  async getUserData(userId: string, userName: string, config?: Config): Promise<UserAccountV2> {
    await this.loadUsersStore()

    if (!this.usersCache!.users[userId]) {
      await this.dataLock.acquire(async () => {
        if (this.usersCache!.users[userId]) return
        this.usersCache!.users[userId] = this.createUserAccount(userId, userName, config)
        await this.saveUsersStoreInternal()
        this.logger.info('创建用户积分数据', { userId, userName })
      })
    }

    return this.usersCache!.users[userId]!
  }

  async getExistingUserData(userId: string): Promise<UserAccountV2 | undefined> {
    const store = await this.loadUsersStore()
    return store.users[userId]
  }

  async getAllUsers(): Promise<Record<string, UserAccountV2>> {
    const store = await this.loadUsersStore()
    return store.users
  }

  checkRateLimit(userId: string, config: Config): { allowed: boolean, message?: string } {
    const now = Date.now()
    const userTimestamps = this.rateLimitMap.get(userId) || []
    const windowStart = now - config.rateLimitWindow * 1000
    const validTimestamps = userTimestamps.filter(timestamp => timestamp > windowStart)
    this.rateLimitMap.set(userId, validTimestamps)

    if (validTimestamps.length >= config.rateLimitMax) {
      const oldest = validTimestamps[0] ?? now
      return {
        allowed: false,
        message: `操作过于频繁，请 ${Math.ceil((oldest + config.rateLimitWindow * 1000 - now) / 1000)} 秒后再试`,
      }
    }

    return { allowed: true }
  }

  updateRateLimit(userId: string): void {
    const now = Date.now()
    const userTimestamps = this.rateLimitMap.get(userId) || []
    userTimestamps.push(now)
    this.rateLimitMap.set(userId, userTimestamps)
  }

  async checkAndReserveQuota(
    userId: string,
    userName: string,
    cost: GenerationCost,
    config: Config,
    platform?: string,
  ): Promise<{ allowed: boolean; message?: string; reservationId?: string }> {
    if (this.isAdmin(userId, config)) return { allowed: true, reservationId: 'admin' }
    if (this.isPermanentMember(userId, config)) return { allowed: true, reservationId: 'permanent_member' }
    if (platform && config.unlimitedPlatforms?.includes(platform)) return { allowed: true, reservationId: 'platform_exempt' }

    const rateLimitCheck = this.checkRateLimit(userId, config)
    if (!rateLimitCheck.allowed) return { ...rateLimitCheck }
    this.updateRateLimit(userId)

    await this.loadUsersStore()
    const userData = await this.getUserData(userId, userName, config)

    return await this.dataLock.acquire(async () => {
      const cachedUserData = this.usersCache!.users[userId] || userData
      const reset = this.ensureDailyReset(cachedUserData, config)
      if (reset) await this.saveUsersStoreInternal()

      const summary = this.buildCreditSummary(cachedUserData, config)
      if (summary.totalAvailable < cost.totalCredits) {
        return {
          allowed: false,
          message: [
            '积分不足',
            '',
            `- 本次需要｜${cost.totalCredits} ${config.creditUnitName}`,
            `- 今日免费｜${summary.dailyFreeRemaining} ${config.creditUnitName}`,
            `- 已购余额｜${summary.purchasedCredits} ${config.creditUnitName}`,
            `- 合计可用｜${summary.totalAvailable} ${config.creditUnitName}`,
          ].join('\n'),
        }
      }

      const reservationId = `${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      return { allowed: true, reservationId }
    })
  }

  async recordUsageOnly(
    userId: string,
    userName: string,
    commandName: string,
    numImages: number,
    config: Config,
  ): Promise<UserAccountV2> {
    await this.loadUsersStore()

    return await this.dataLock.acquire(async () => {
      let userData = this.usersCache!.users[userId]
      if (!userData) {
        userData = this.createUserAccount(userId, userName, config)
        this.usersCache!.users[userId] = userData
      }
      this.ensureDailyReset(userData, config)
      const now = new Date().toISOString()
      userData.userName = userName || userData.userName
      userData.updatedAt = now
      userData.lastUsedAt = now
      userData.statistics.totalImagesGenerated += Math.max(0, Math.floor(numImages || 0))
      userData.statistics.totalGenerationRequests += 1
      userData.statistics.lastModelId = commandName
      await this.saveUsersStoreInternal()
      return userData
    })
  }

  async consumeCredits(
    userId: string,
    userName: string,
    commandName: string,
    cost: GenerationCost,
    config: Config,
    requestId?: string,
  ): Promise<CreditConsumeResult> {
    await this.loadUsersStore()

    return await this.dataLock.acquire(async () => {
      let userData = this.usersCache!.users[userId]
      if (!userData) {
        userData = this.createUserAccount(userId, userName, config)
        this.usersCache!.users[userId] = userData
      }

      this.ensureDailyReset(userData, config)
      const before = this.snapshotBalance(userData, config)
      const now = new Date().toISOString()
      const totalCredits = roundCredits(cost.totalCredits)

      let remaining = totalCredits
      const freeAvailable = this.getDailyFreeRemaining(userData, config)
      const freeUsed = Math.min(freeAvailable, remaining)
      if (freeUsed > 0) {
        userData.balance.dailyFreeCreditsUsed = roundCredits(userData.balance.dailyFreeCreditsUsed + freeUsed)
        remaining = roundCredits(remaining - freeUsed)
      }

      const purchasedUsed = Math.min(userData.balance.purchasedCredits, remaining)
      if (purchasedUsed > 0) {
        userData.balance.purchasedCredits = roundCredits(userData.balance.purchasedCredits - purchasedUsed)
        remaining = roundCredits(remaining - purchasedUsed)
      }

      if (remaining > 0) {
        throw new Error(`积分扣费失败｜余额不足｜缺少 ${remaining} ${config.creditUnitName}`)
      }

      userData.userName = userName || userData.userName
      userData.updatedAt = now
      userData.lastUsedAt = now
      userData.balance.totalConsumedCredits = roundCredits(userData.balance.totalConsumedCredits + totalCredits)
      userData.statistics.totalImagesGenerated += cost.numImages
      userData.statistics.totalGenerationRequests += 1
      if (cost.modelId) userData.statistics.lastModelId = cost.modelId

      const event = this.buildLedgerEvent(userData, 'consume', totalCredits, before, this.snapshotBalance(userData, config), '图像生成扣费', {
        generation: {
          commandName,
          modelId: cost.modelId,
          modelSuffix: cost.modelSuffix,
          numImages: cost.numImages,
          creditCostPerImage: cost.creditCostPerImage,
          totalCredits,
          requestId,
        },
        metadata: {
          costSource: cost.costSource,
        },
      })

      await this.appendLedgerEvent(event)
      await this.saveUsersStoreInternal()
      return { userData, ledgerEvent: event, freeUsed, purchasedUsed, isExempt: false }
    })
  }

  async grantCredits(
    userId: string,
    userName: string,
    amount: number,
    reason: string,
    operator: { userId: string; userName: string },
    config: Config,
  ): Promise<{ userData: UserAccountV2; ledgerEvent: CreditLedgerEventV2; rechargeRecord: RechargeRecordV2 }> {
    await this.loadUsersStore()
    const normalizedAmount = roundCredits(amount)
    if (normalizedAmount <= 0) throw new Error('充值积分必须大于 0')

    return await this.dataLock.acquire(async () => {
      let userData = this.usersCache!.users[userId]
      if (!userData) {
        userData = this.createUserAccount(userId, userName, config)
        this.usersCache!.users[userId] = userData
      }
      this.ensureDailyReset(userData, config)
      const before = this.snapshotBalance(userData, config)
      userData.userName = userName || userData.userName
      userData.balance.purchasedCredits = roundCredits(userData.balance.purchasedCredits + normalizedAmount)
      userData.balance.totalGrantedCredits = roundCredits(userData.balance.totalGrantedCredits + normalizedAmount)
      userData.updatedAt = new Date().toISOString()

      const event = this.buildLedgerEvent(userData, 'grant', normalizedAmount, before, this.snapshotBalance(userData, config), reason || '管理员充值', { operator })
      await this.appendLedgerEvent(event)

      const rechargeRecord: RechargeRecordV2 = {
        schemaVersion: 2,
        id: `recharge-${event.id}`,
        timestamp: event.timestamp,
        userId,
        userName: userData.userName,
        amount: normalizedAmount,
        reason: reason || '管理员充值',
        operator,
        ...(config.creditsPerCny ? { estimatedCny: roundCredits(normalizedAmount / config.creditsPerCny) } : {}),
        ledgerSequence: event.sequence,
      }
      await this.appendJsonLine(this.rechargeRecordsFile, rechargeRecord)
      await this.saveUsersStoreInternal()
      return { userData, ledgerEvent: event, rechargeRecord }
    })
  }

  async adjustCredits(
    userId: string,
    userName: string,
    amount: number,
    reason: string,
    operator: { userId: string; userName: string },
    config: Config,
  ): Promise<{
    userData: UserAccountV2
    ledgerEvent?: CreditLedgerEventV2
    requestedAmount: number
    deductedAmount: number
    isPartial: boolean
  }> {
    await this.loadUsersStore()
    const normalizedAmount = roundCredits(amount)
    if (normalizedAmount <= 0) throw new Error('扣除积分必须大于 0')

    return await this.dataLock.acquire(async () => {
      let userData = this.usersCache!.users[userId]
      if (!userData) {
        userData = this.createUserAccount(userId, userName, config)
        this.usersCache!.users[userId] = userData
      }
      this.ensureDailyReset(userData, config)
      const before = this.snapshotBalance(userData, config)
      const deduct = roundCredits(Math.min(userData.balance.purchasedCredits, normalizedAmount))
      if (deduct <= 0) {
        await this.saveUsersStoreInternal()
        return {
          userData,
          requestedAmount: normalizedAmount,
          deductedAmount: 0,
          isPartial: true,
        }
      }

      userData.balance.purchasedCredits = roundCredits(userData.balance.purchasedCredits - deduct)
      userData.balance.totalConsumedCredits = roundCredits(userData.balance.totalConsumedCredits + deduct)
      userData.updatedAt = new Date().toISOString()

      const event = this.buildLedgerEvent(userData, 'adjust', deduct, before, this.snapshotBalance(userData, config), reason || '管理员扣除', { operator })
      await this.appendLedgerEvent(event)
      await this.saveUsersStoreInternal()
      return {
        userData,
        ledgerEvent: event,
        requestedAmount: normalizedAmount,
        deductedAmount: deduct,
        isPartial: deduct < normalizedAmount,
      }
    })
  }

  async listLedgerEvents(userId?: string, limit = 10): Promise<CreditLedgerEventV2[]> {
    try {
      if (!existsSync(this.ledgerFile)) return []
      const content = await fs.readFile(this.ledgerFile, 'utf-8')
      const lines = content.split('\n').map(line => line.trim()).filter(Boolean)
      const rows: CreditLedgerEventV2[] = []
      for (let index = lines.length - 1; index >= 0 && rows.length < limit; index--) {
        try {
          const event = JSON.parse(lines[index]!) as CreditLedgerEventV2
          if (!userId || event.userId === userId) rows.push(event)
        } catch (error) {
          this.logger.warn('跳过损坏的积分流水行', { index, error })
        }
      }
      return rows
    } catch (error) {
      this.logger.error('读取积分流水失败', error)
      return []
    }
  }

  buildCreditSummary(userData: UserAccountV2, config: Config): CreditSummary {
    this.ensureDailyReset(userData, config)
    const dailyFreeRemaining = this.getDailyFreeRemaining(userData, config)
    const purchasedCredits = roundCredits(userData.balance.purchasedCredits)
    const totalAvailable = roundCredits(dailyFreeRemaining + purchasedCredits)
    const summary: CreditSummary = {
      userId: userData.userId,
      userName: userData.userName,
      dailyFreeRemaining,
      purchasedCredits,
      totalAvailable,
      totalGrantedCredits: roundCredits(userData.balance.totalGrantedCredits),
      totalConsumedCredits: roundCredits(userData.balance.totalConsumedCredits),
      totalRefundedCredits: roundCredits(userData.balance.totalRefundedCredits),
      totalImagesGenerated: userData.statistics.totalImagesGenerated,
      totalGenerationRequests: userData.statistics.totalGenerationRequests,
      ...(userData.lastUsedAt ? { lastUsedAt: userData.lastUsedAt } : {}),
    }
    if (config.showEstimatedCny && config.creditsPerCny && config.creditsPerCny > 0) {
      summary.estimatedCny = roundCredits(totalAvailable / config.creditsPerCny)
    }
    return summary
  }

  private getDailyFreeRemaining(userData: UserAccountV2, config: Config): number {
    const limit = roundCredits(userData.balance.dailyFreeCreditsLimitSnapshot ?? config.dailyFreeCredits ?? 0)
    return roundCredits(Math.max(0, limit - userData.balance.dailyFreeCreditsUsed))
  }

  private snapshotBalance(userData: UserAccountV2, config: Config): CreditBalanceSnapshotV2 {
    const dailyFreeRemaining = this.getDailyFreeRemaining(userData, config)
    const purchasedCredits = roundCredits(userData.balance.purchasedCredits)
    return {
      dailyFreeRemaining,
      purchasedCredits,
      totalAvailable: roundCredits(dailyFreeRemaining + purchasedCredits),
      totalGrantedCredits: roundCredits(userData.balance.totalGrantedCredits),
      totalConsumedCredits: roundCredits(userData.balance.totalConsumedCredits),
      totalRefundedCredits: roundCredits(userData.balance.totalRefundedCredits),
    }
  }

  private buildLedgerEvent(
    userData: UserAccountV2,
    type: CreditLedgerEventV2['type'],
    amount: number,
    balanceBefore: CreditBalanceSnapshotV2,
    balanceAfter: CreditBalanceSnapshotV2,
    reason: string,
    extra: Partial<Pick<CreditLedgerEventV2, 'operator' | 'generation' | 'metadata'>> = {},
  ): CreditLedgerEventV2 {
    const sequence = (this.usersCache?.metadata.lastLedgerSequence || 0) + 1
    if (this.usersCache) this.usersCache.metadata.lastLedgerSequence = sequence
    const timestamp = new Date().toISOString()
    return {
      schemaVersion: 2,
      sequence,
      id: `ledger-${sequence}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp,
      userId: userData.userId,
      userName: userData.userName,
      type,
      amount: roundCredits(amount),
      balanceBefore,
      balanceAfter,
      reason,
      ...(extra.operator ? { operator: extra.operator } : {}),
      ...(extra.generation ? { generation: extra.generation } : {}),
      ...(extra.metadata ? { metadata: extra.metadata } : {}),
    }
  }

  private async appendLedgerEvent(event: CreditLedgerEventV2): Promise<void> {
    await this.ledgerLock.acquire(async () => {
      await this.appendJsonLine(this.ledgerFile, event)
    })
  }

  private async appendJsonLine(path: string, value: unknown): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.appendFile(path, `${JSON.stringify(value)}\n`, 'utf-8')
  }

  async recordSecurityBlock(userId: string, config: Config): Promise<{ shouldWarn: boolean, shouldDeduct: boolean, blockCount: number }> {
    if (!userId) return { shouldWarn: false, shouldDeduct: false, blockCount: 0 }
    if (this.isAdmin(userId, config)) return { shouldWarn: false, shouldDeduct: false, blockCount: 0 }

    const now = Date.now()
    const windowMs = config.securityBlockWindow * 1000
    const windowStart = now - windowMs

    let blockTimestamps = this.securityBlockMap.get(userId) || []
    blockTimestamps = blockTimestamps.filter(timestamp => timestamp > windowStart)
    blockTimestamps.push(now)
    this.securityBlockMap.set(userId, blockTimestamps)

    const blockCount = blockTimestamps.length
    const hasWarning = this.securityWarningMap.get(userId) || false

    let shouldWarn = false
    let shouldDeduct = false
    if (blockCount >= config.securityBlockWarningThreshold && !hasWarning) {
      this.securityWarningMap.set(userId, true)
      shouldWarn = true
    } else if (blockCount > config.securityBlockWarningThreshold) {
      shouldDeduct = true
    }

    return { shouldWarn, shouldDeduct, blockCount }
  }
}
