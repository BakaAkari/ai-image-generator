/**
 * WizardSessionManager —— 向导状态管理。
 *
 * - 会话键为 `platform:userId` —— 「跟账户走」（用户明确的设计决策）：
 *   每个用户全局有且仅有一条图像生成链路，跨群/私聊共享同一条向导，
 *   避免同一账户并发发起多条生成链路
 * - 每步超时由配置驱动（与 apiTimeout / 编排器等待提示一致，Bug 3.3）；
 *   超时回收后用户下一次发消息时会收到一次「已超时退出」提醒
 * - 提供 start / get / takeIfExpired / touch / cancel / cleanup 操作
 */
export interface WizardSession {
  /** 会话键（platform:userId），Map 的 key */
  sessionKey: string
  userId: string
  userName: string
  /** 当前向导步骤 */
  step: 'await-prompt' | 'model-select' | 'param-resolution' | 'param-select' | 'confirm' | 'generating'
  /** 生成模式 */
  mode: 'text-to-image' | 'image-to-image' | 'compose-image'
  /** 用户输入的 prompt */
  prompt?: string
  /** 图生图时带上的图片 URL（1 张）；合成图时为多张（2-8） */
  imageUrls?: string[]
  /** 用户选择的模型 ID */
  modelId?: string
  /** 模型对应的协议（从 catalog route 读取，用于参数渲染） */
  protocol?: string
  /** 已收集的参数键值对 */
  params: Record<string, string | number>
  /** 选定模型后按契约过滤的参数定义（wizard contract-aware params）；未设置时回退协议级 PROTOCOL_PARAMS */
  paramDefs?: import('../shared/protocol-params.js').ParamDef[]
  /** 会话开始时间戳 */
  startedAt: number
  /** 最近一次步骤推进（或用户交互）的时间戳，用于每步超时判定 */
  lastActivityAt: number
  /** 锁定 prompt（style 预设场景） */
  lockedPrompt?: string
  /** 锁定模式（style 预设场景：不允许切换 文生图/图生图） */
  lockedMode?: boolean
  /** 对话 ID（图像记忆用） */
  conversationId?: string
  /** 原始命令名称（文生图/图生图/预设名） */
  commandName?: string
  /** 当前参数收集索引 */
  currentParamIndex?: number
  /** 命令行上已解析的图像参数（-1k/-16:9/-add ...），确认时并入 requestContext */
  preResolution?: string
  preAspectRatio?: string
  preCustomAdditions?: string[]
  /** 会话所在平台（用于免计费平台判断，避免向导渲染时显示无关积分文案） */
  platform?: string
}

export interface WizardStartOptions {
  prompt?: string
  mode?: boolean
  commandName?: string
}

const DEFAULT_STEP_TIMEOUT_MS = 120_000

export class WizardSessionManager {
  private sessions = new Map<string, WizardSession>()
  /** 每步超时，由调用方按配置提供（默认 120s，仅作兜底） */
  private readonly getTimeoutMs: () => number

  constructor(getTimeoutMs?: () => number) {
    this.getTimeoutMs = getTimeoutMs ?? (() => DEFAULT_STEP_TIMEOUT_MS)
  }

  private get timeoutMs(): number {
    const v = this.getTimeoutMs()
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_STEP_TIMEOUT_MS
  }

  /**
   * 开始新向导会话。
   * 如果该会话键下已有活跃会话，返回冲突信息。
   */
  start(
    sessionKey: string,
    userId: string,
    userName: string,
    mode: 'text-to-image' | 'image-to-image' | 'compose-image',
    lockedOptions?: WizardStartOptions,
  ): WizardSession | { conflict: true; message: string } {
    const existing = this.sessions.get(sessionKey)
    if (existing && existing.step !== 'generating') {
      return {
        conflict: true,
        message: '已有进行中的生成向导，回复「取消」退出当前向导后重试',
      }
    }

    const now = Date.now()
    const session: WizardSession = {
      sessionKey,
      userId,
      userName,
      step: 'await-prompt',
      mode,
      params: {},
      startedAt: now,
      lastActivityAt: now,
    }

    // 锁定 prompt 场景（style 预设命令）：跳过 await-prompt 直接进入模型选择
    if (lockedOptions?.prompt !== undefined) {
      session.prompt = lockedOptions.prompt
      session.lockedPrompt = lockedOptions.prompt
      session.step = 'model-select'
    }

    if (lockedOptions?.mode !== undefined) {
      session.lockedMode = lockedOptions.mode
    }

    if (lockedOptions?.commandName !== undefined) {
      session.commandName = lockedOptions.commandName
    }

    this.sessions.set(sessionKey, session)
    return session
  }

  /** 获取当前活跃会话（自上次活动 timeoutMs 内视为活跃，否则删除并返回 undefined） */
  get(sessionKey: string): WizardSession | undefined {
    const s = this.sessions.get(sessionKey)
    if (!s) return undefined
    if (Date.now() - s.lastActivityAt > this.timeoutMs) {
      this.sessions.delete(sessionKey)
      return undefined
    }
    return s
  }

  /**
   * 若该会话键下存在「已超时」的会话，删除并返回它；否则返回 undefined。
   * 用于中间件在用户超时后第一次发消息时给出一次提醒（Bug 3.3）。
   */
  takeIfExpired(sessionKey: string): WizardSession | undefined {
    const s = this.sessions.get(sessionKey)
    if (!s) return undefined
    if (Date.now() - s.lastActivityAt <= this.timeoutMs) return undefined
    this.sessions.delete(sessionKey)
    return s
  }

  /** 标记会话已推进/收到用户输入，刷新超时时钟 */
  touch(session: WizardSession): void {
    session.lastActivityAt = Date.now()
  }

  /** 取消/删除会话。返回 true 表示确实删除了会话。 */
  cancel(sessionKey: string): boolean {
    return this.sessions.delete(sessionKey)
  }

  /** 清理过期会话 */
  cleanup(): void {
    const now = Date.now()
    const cutoff = now - this.timeoutMs
    for (const [key, s] of this.sessions) {
      if (s.lastActivityAt < cutoff) {
        this.sessions.delete(key)
      }
    }
  }

  /** 获取当前活跃会话数（仅用于日志） */
  getActiveCount(): number {
    return this.sessions.size
  }
}
