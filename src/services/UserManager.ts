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
  trialImagesUsed: number
  trialDate?: string
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
  reservations: Record<string, CreditReservation>
  metadata: {
    plugin: 'aka-ai-image-generator'
    billingUnit: 'credit'
    lastLedgerSequence: number
  }
}

export interface CreditBalanceSnapshotV2 {
  trialRemaining: number
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
  ledgerSequence: number
}

export interface CreditSummary {
  userId: string
  userName: string
  trialRemaining: number
  purchasedCredits: number
  totalAvailable: number
  totalGrantedCredits: number
  totalConsumedCredits: number
  totalRefundedCredits: number
  totalImagesGenerated: number
  totalGenerationRequests: number
  lastUsedAt?: string
}

export interface CreditReservation {
  reservationId: string
  userId: string
  userName: string
  cost: GenerationCost
  reservedCredits: number
  status: 'active' | 'settled' | 'released'
  createdAt: number
  expiresAt: number
  isTrial: boolean
  result?: CreditReservationResult
}

export interface CreditReservationResult {
  reservationId: string
  reservedCredits: number
  settledCredits: number
  releasedCredits: number
  actualImages: number
  status: 'settled' | 'released'
}

export class UserManager {
  private dataDir: string
  private usersFile: string
  private usersBackupFile: string
  private ledgerFile: string
  private rechargeRecordsFile: string
  private reservationsFile: string
  private snapshotsDir: string
  private logger: any
  private dataLock = new AsyncLock()
  private ledgerLock = new AsyncLock()

  private usersCache: UsersStoreV2 | null = null
  private activeTasks = new Map<string, { requestId: string; startedAt: number; expiresAt: number }>()
  private rateLimitMap = new Map<string, number[]>()
  private securityBlockMap = new Map<string, number[]>()
  private securityWarningMap = new Map<string, boolean>()
  private creditReservations = new Map<string, CreditReservation>()
  private reservationsLoaded = false
  /** 定时清理 volatile map 的 timer handle */
  private pruneTimer: ReturnType<typeof setInterval> | undefined

  constructor(baseDir: string, logger: any) {
    this.logger = logger
    this.dataDir = baseDir
    this.usersFile = join(this.dataDir, 'users.v2.json')
    this.usersBackupFile = join(this.dataDir, 'users.v2.json.backup')
    this.ledgerFile = join(this.dataDir, 'credit-ledger.v2.jsonl')
    this.rechargeRecordsFile = join(this.dataDir, 'recharge-records.v2.jsonl')
    this.reservationsFile = join(this.dataDir, 'credit-reservations.v1.json')
    this.snapshotsDir = join(this.dataDir, 'snapshots')

    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true })
    if (!existsSync(this.snapshotsDir)) mkdirSync(this.snapshotsDir, { recursive: true })

    // 每 5 分钟清理一次过期数据，防止内存泄漏
    this.pruneTimer = setInterval(() => this.pruneStaleMaps(), 5 * 60 * 1000)
    this.pruneTimer.unref()
  }

  dispose() {
    if (this.pruneTimer !== undefined) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = undefined
    }
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

  /** 清理 volatile map 中长期不活跃的条目 */
  private pruneStaleMaps() {
    const now = Date.now()
    // 限频窗口（取 2 倍 rateLimitWindow 或 10 分钟兜底）
    const rateLimitWindowMs = Math.max(10 * 60 * 1000, this.defaultPruneWindowMs)

    for (const [userId, timestamps] of this.rateLimitMap) {
      const valid = timestamps.filter(t => t > now - rateLimitWindowMs)
      if (valid.length === 0) {
        this.rateLimitMap.delete(userId)
      } else {
        this.rateLimitMap.set(userId, valid)
      }
    }

    for (const [userId] of this.securityBlockMap) {
      // securityBlockWindow 由 config 控制但运行时拿不到，使用 1 小时兜底
      if (!this.securityBlockMap.has(userId)) continue
      const timestamps = this.securityBlockMap.get(userId)!
      const valid = timestamps.filter(t => t > now - 3600_000)
      if (valid.length === 0) {
        this.securityBlockMap.delete(userId)
        this.securityWarningMap.delete(userId)
      } else {
        this.securityBlockMap.set(userId, valid)
      }
    }
  }

  /** 默认清理窗口，pruneStaleMaps 使用 */
  private get defaultPruneWindowMs(): number {
    return 10 * 60 * 1000
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
      reservations: {},
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
          this.creditReservations = new Map(Object.entries(this.usersCache.reservations))
          this.reservationsLoaded = true
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
      this.creditReservations.clear()
      this.reservationsLoaded = true
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
        reservations: value.reservations && typeof value.reservations === 'object' ? value.reservations : {},
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
    this.usersCache.reservations = Object.fromEntries(this.creditReservations)
    try {
      if (existsSync(this.usersFile)) {
        await fs.copyFile(this.usersFile, this.usersBackupFile)
      }
      await this.atomicWriteFile(this.usersFile, JSON.stringify(this.usersCache, null, 2))
    } catch (error) {
      // 持久化失败不中断业务：数据仍在内存缓存中，下次成功写入即可恢复
      this.logger.error('保存用户积分数据失败（内存缓存仍有效，将在下次操作重试）', error)
    }
  }

  private async atomicWriteFile(path: string, content: string): Promise<void> {
    const dir = dirname(path)
    await fs.mkdir(dir, { recursive: true })

    // 验证目录确实存在
    try { await fs.access(dir) } catch {
      await fs.mkdir(dir, { recursive: true })
    }

    const tempFile = `${path}.tmp`
    const bakFile = `${path}.bak`

    // 3 次重试 + 递增延迟
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await fs.writeFile(tempFile, content, 'utf-8')
        // 验证 tmp 已写入
        await fs.access(tempFile)
        await fs.rename(tempFile, path)
        return
      } catch (err) {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 100 * (attempt + 1)))
          continue
        }
        // 最后一次失败：写 .bak 降级，不抛异常
        this.logger.warn('atomicWriteFile 重试 3 次后仍失败 (path=%s)，降级写入 .bak', path)
        try {
          await fs.writeFile(bakFile, content, 'utf-8')
        } catch {
          this.logger.error('atomicWriteFile .bak 降级写入也失败', err)
        }
        throw err
      }
    }
  }

  private createUserAccount(userId: string, userName: string, config?: Config): UserAccountV2 {
    const now = new Date().toISOString()
    return {
      userId,
      userName: userName || userId,
      createdAt: now,
      updatedAt: now,
      balance: {
        trialImagesUsed: 0,
        trialDate: new Date().toISOString().slice(0, 10),
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

  private getTrialRemaining(userData: UserAccountV2, config: Config): number {
    const limit = config.trialImageLimit ?? 3
    const today = new Date().toISOString().slice(0, 10)
    if (userData.balance.trialDate !== today) {
      userData.balance.trialImagesUsed = 0
      userData.balance.trialDate = today
    }
    return Math.max(0, limit - userData.balance.trialImagesUsed)
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

  private async loadReservations(): Promise<void> {
    if (this.reservationsLoaded) return
    // One-release migration path from the short-lived standalone reservation file.
    try {
      const parsed = JSON.parse(await fs.readFile(this.reservationsFile, 'utf8')) as { reservations?: CreditReservation[] }
      for (const reservation of parsed.reservations ?? []) this.creditReservations.set(reservation.reservationId, reservation)
      if (this.usersCache) {
        this.usersCache.reservations = Object.fromEntries(this.creditReservations)
        await this.saveUsersStoreInternal()
      }
      await fs.unlink(this.reservationsFile).catch(() => undefined)
    } catch { /* no legacy file */ }
    this.reservationsLoaded = true
  }


  async reconcileExpiredReservations(config: Config, now = Date.now()): Promise<number> {
    await this.loadUsersStore()
    await this.loadReservations()
    return await this.dataLock.acquire(async () => {
      let released = 0
      for (const reservation of this.creditReservations.values()) {
        if (reservation.status !== 'active' || reservation.expiresAt > now) continue
        const user = this.usersCache!.users[reservation.userId]
        if (!user) continue
        user.balance.purchasedCredits = roundCredits(user.balance.purchasedCredits + reservation.reservedCredits)
        const result: CreditReservationResult = {
          reservationId: reservation.reservationId,
          reservedCredits: reservation.reservedCredits,
          settledCredits: 0,
          releasedCredits: reservation.reservedCredits,
          actualImages: 0,
          status: 'released',
        }
        reservation.status = 'released'
        reservation.result = result
        user.updatedAt = new Date(now).toISOString()
        released += 1
      }
      if (released > 0) {
        await this.saveUsersStoreInternal()
        this.logger.warn('已释放过期图像积分预授权', { released })
      }
      return released
    })
  }

  async reserveCredits(
    userId: string,
    userName: string,
    reservationId: string,
    cost: GenerationCost,
    config: Config,
    platform?: string,
    ttlMs = 15 * 60 * 1000,
  ): Promise<{ allowed: boolean; message?: string; reservationId?: string; isTrial?: boolean }> {
    await this.loadUsersStore()
    await this.loadReservations()
    return await this.dataLock.acquire(async () => {
      const existing = this.creditReservations.get(reservationId)
      if (existing) return { allowed: existing.status === 'active', reservationId }
      let user = this.usersCache!.users[userId]
      if (!user) {
        user = this.createUserAccount(userId, userName, config)
        this.usersCache!.users[userId] = user
      }
      const exempt = this.isAdmin(userId, config) || this.isPermanentMember(userId, config)

      // 免计费平台：指定平台上的生成完全免费，不消耗积分和试用额度
      const isFreePlatform = platform != null && Array.isArray(config.freePlatforms) && config.freePlatforms.includes(platform)
      if (isFreePlatform) {
        this.creditReservations.set(reservationId, {
          reservationId, userId, userName, cost,
          reservedCredits: 0,
          status: 'active',
          createdAt: Date.now(),
          expiresAt: Date.now() + Math.max(60_000, ttlMs),
          isTrial: true,
        })
        await this.saveUsersStoreInternal()
        this.updateRateLimit(userId)
        return { allowed: true, reservationId, isTrial: true }
      }

      const total = exempt ? 0 : roundCredits(cost.totalCredits)

      // 试用额度检查：trialImageLimit > 0 且用户尚未用完所有试用次数
      const trialRemaining = this.getTrialRemaining(user, config)
      const isTrial = !exempt && config.trialImageLimit > 0 && trialRemaining > 0

      if (isTrial) {
        // 试用图片跳过积分检查，直接预授权
        this.creditReservations.set(reservationId, {
          reservationId, userId, userName, cost,
          reservedCredits: 0,
          status: 'active',
          createdAt: Date.now(),
          expiresAt: Date.now() + Math.max(60_000, ttlMs),
          isTrial: true,
        })
        await this.saveUsersStoreInternal()
        this.updateRateLimit(userId)
        return { allowed: true, reservationId, isTrial: true }
      }

      // 正常积分检查
      const purchasedAvailable = roundCredits(user.balance.purchasedCredits)
      if (purchasedAvailable < total) {
        return { allowed: false, message: `积分不足｜本次需要 ${total} ${config.creditUnitName}` }
      }
      user.balance.purchasedCredits = roundCredits(user.balance.purchasedCredits - total)
      this.creditReservations.set(reservationId, {
        reservationId, userId, userName, cost,
        reservedCredits: total,
        status: 'active',
        createdAt: Date.now(),
        expiresAt: Date.now() + Math.max(60_000, ttlMs),
        isTrial: false,
      })
      await this.saveUsersStoreInternal()
      this.updateRateLimit(userId)
      return { allowed: true, reservationId, isTrial: false }
    })
  }

  async settleReservation(
    reservationId: string,
    actualImages: number,
    commandName: string,
    config: Config,
    evidence: Record<string, unknown> | null,
  ): Promise<CreditReservationResult & { isTrial?: boolean }> {
    await this.loadUsersStore()
    await this.loadReservations()
    return await this.dataLock.acquire(async () => {
      const reservation = this.creditReservations.get(reservationId)
      if (!reservation) throw new Error(`预授权不存在：${reservationId}`)
      if (reservation.result) return reservation.result as CreditReservationResult & { isTrial?: boolean }
      const user = this.usersCache!.users[reservation.userId]
      if (!user) throw new Error(`预授权用户不存在：${reservation.userId}`)
      const delivered = Math.max(0, Math.min(reservation.cost.numImages, Math.floor(actualImages || 0)))

      if (reservation.isTrial) {
        // 试用：仅增加计数器，不涉及积分
        user.balance.trialImagesUsed += delivered
        user.balance.trialDate = new Date().toISOString().slice(0, 10)
        user.statistics.totalImagesGenerated += delivered
        user.statistics.totalGenerationRequests += 1
        if (reservation.cost.modelId) user.statistics.lastModelId = reservation.cost.modelId
        user.updatedAt = new Date().toISOString()
        const result: CreditReservationResult & { isTrial: boolean } = {
          reservationId,
          reservedCredits: reservation.reservedCredits,
          settledCredits: 0,
          releasedCredits: 0,
          actualImages: delivered,
          status: 'settled',
          isTrial: true,
        }
        reservation.status = 'settled'
        reservation.result = result
        await this.saveUsersStoreInternal()
        return result
      }

      // 后生成定价：优先使用 evidence.actualCost（真实消耗），否则退回预授权估算
      const actualCost = typeof evidence?.actualCost === 'number' && evidence.actualCost > 0 ? evidence.actualCost : null
      const costPerImage = actualCost ?? reservation.cost.creditCostPerImage
      const settledCredits = roundCredits(costPerImage * delivered)
      const releasedCredits = roundCredits(reservation.reservedCredits - settledCredits)
      const before = this.snapshotBalance(user, config)
      user.balance.purchasedCredits = roundCredits(user.balance.purchasedCredits + releasedCredits)
      user.balance.totalConsumedCredits = roundCredits(user.balance.totalConsumedCredits + settledCredits)
      user.statistics.totalImagesGenerated += delivered
      user.statistics.totalGenerationRequests += 1
      if (reservation.cost.modelId) user.statistics.lastModelId = reservation.cost.modelId
      user.updatedAt = new Date().toISOString()
      const result: CreditReservationResult & { isTrial?: boolean } = {
        reservationId,
        reservedCredits: reservation.reservedCredits,
        settledCredits,
        releasedCredits,
        actualImages: delivered,
        status: 'settled',
        isTrial: false,
      }
      reservation.status = 'settled'
      reservation.result = result
      const event = this.buildLedgerEvent(user, 'consume', settledCredits, before, this.snapshotBalance(user, config), '图像生成预授权结算', {
        generation: {
          commandName,
          modelId: reservation.cost.modelId,
          modelSuffix: reservation.cost.modelSuffix,
          numImages: delivered,
          creditCostPerImage: reservation.cost.creditCostPerImage,
          totalCredits: settledCredits,
          requestId: reservationId,
        },
        metadata: {
          reservationId,
          reservedCredits: reservation.reservedCredits,
          settledCredits,
          releasedCredits,
          evidence,
        },
      })
      await this.appendLedgerEvent(event)
      await this.saveUsersStoreInternal()
      return result
    })
  }

  async releaseReservation(reservationId: string, config: Config, reason: string): Promise<CreditReservationResult> {
    await this.loadUsersStore()
    await this.loadReservations()
    return await this.dataLock.acquire(async () => {
      const reservation = this.creditReservations.get(reservationId)
      if (!reservation) throw new Error(`预授权不存在：${reservationId}`)
      if (reservation.result) return reservation.result
      const user = this.usersCache!.users[reservation.userId]
      if (!user) throw new Error(`预授权用户不存在：${reservation.userId}`)
      if (!reservation.isTrial) {
        user.balance.purchasedCredits = roundCredits(user.balance.purchasedCredits + reservation.reservedCredits)
      }
      user.updatedAt = new Date().toISOString()
      const result: CreditReservationResult = {
        reservationId,
        reservedCredits: reservation.reservedCredits,
        settledCredits: 0,
        releasedCredits: reservation.reservedCredits,
        actualImages: 0,
        status: 'released',
      }
      reservation.status = 'released'
      reservation.result = result
      this.logger.info('释放图像积分预授权', { reservationId, reason })
      await this.saveUsersStoreInternal()
      return result
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
    if (normalizedAmount <= 0) throw new Error('调整积分必须大于 0')

    return await this.dataLock.acquire(async () => {
      let userData = this.usersCache!.users[userId]
      if (!userData) {
        userData = this.createUserAccount(userId, userName, config)
        this.usersCache!.users[userId] = userData
      }
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

      const event = this.buildLedgerEvent(userData, 'adjust', deduct, before, this.snapshotBalance(userData, config), reason || '管理员余额修正', { operator })
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
    const trialRemaining = this.getTrialRemaining(userData, config)
    const purchasedCredits = roundCredits(userData.balance.purchasedCredits)
    const totalAvailable = roundCredits(purchasedCredits)
    const summary: CreditSummary = {
      userId: userData.userId,
      userName: userData.userName,
      trialRemaining,
      purchasedCredits,
      totalAvailable,
      totalGrantedCredits: roundCredits(userData.balance.totalGrantedCredits),
      totalConsumedCredits: roundCredits(userData.balance.totalConsumedCredits),
      totalRefundedCredits: roundCredits(userData.balance.totalRefundedCredits),
      totalImagesGenerated: userData.statistics.totalImagesGenerated,
      totalGenerationRequests: userData.statistics.totalGenerationRequests,
      ...(userData.lastUsedAt ? { lastUsedAt: userData.lastUsedAt } : {}),
    }
    return summary
  }

  private snapshotBalance(userData: UserAccountV2, config: Config): CreditBalanceSnapshotV2 {
    const trialRemaining = this.getTrialRemaining(userData, config)
    const purchasedCredits = roundCredits(userData.balance.purchasedCredits)
    return {
      trialRemaining,
      purchasedCredits,
      totalAvailable: roundCredits(purchasedCredits),
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
