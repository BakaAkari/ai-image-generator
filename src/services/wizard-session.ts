/**
 * WizardSessionManager —— 每用户单会话向导状态管理。
 *
 * - 每用户只有一条活跃会话，新命令阻塞
 * - 会话 6 分钟（3 × timeoutMs）不活跃自动回收
 * - 提供 start / get / cancel / cleanup 四个核心操作
 */
export interface WizardSession {
  userId: string
  userName: string
  /** 当前向导步骤 */
  step: 'await-prompt' | 'model-select' | 'param-select' | 'confirm' | 'generating'
  /** 生成模式 */
  mode: 'text-to-image' | 'image-to-image'
  /** 用户输入的 prompt */
  prompt?: string
  /** 图生图时带上的图片 URL */
  imageUrls?: string[]
  /** 用户选择的模型 ID */
  modelId?: string
  /** 模型对应的协议（从 catalog route 读取，用于参数渲染） */
  protocol?: string
  /** 已收集的参数键值对 */
  params: Record<string, string | number>
  /** 会话开始时间戳 */
  startedAt: number
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
}

export interface WizardStartOptions {
  prompt?: string
  mode?: boolean
  commandName?: string
}

export class WizardSessionManager {
  private sessions = new Map<string, WizardSession>()
  private timeoutMs = 120_000 // 每步 2 分钟超时

  /**
   * 开始新向导会话。
   * 如果用户已有活跃会话，返回冲突信息。
   */
  start(
    userId: string,
    userName: string,
    mode: 'text-to-image' | 'image-to-image',
    lockedOptions?: WizardStartOptions,
  ): WizardSession | { conflict: true; message: string } {
    const existing = this.sessions.get(userId)
    if (existing && existing.step !== 'generating') {
      return {
        conflict: true,
        message: '已有进行中的生成向导，回复「取消」退出当前向导后重试',
      }
    }

    const session: WizardSession = {
      userId,
      userName,
      step: 'await-prompt',
      mode,
      params: {},
      startedAt: Date.now(),
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

    this.sessions.set(userId, session)
    return session
  }

  /** 获取用户当前会话（已超时则删除并返回 undefined） */
  get(userId: string): WizardSession | undefined {
    const s = this.sessions.get(userId)
    if (!s) return undefined
    if (Date.now() - s.startedAt > this.timeoutMs * 3) {
      this.sessions.delete(userId)
      return undefined
    }
    return s
  }

  /** 取消/删除用户会话。返回 true 表示确实删除了会话。 */
  cancel(userId: string): boolean {
    return this.sessions.delete(userId)
  }

  /** 清理过期会话 */
  cleanup(): void {
    const now = Date.now()
    const cutoff = now - this.timeoutMs * 3
    for (const [userId, s] of this.sessions) {
      if (s.startedAt < cutoff) {
        this.sessions.delete(userId)
      }
    }
  }

  /** 获取当前活跃会话数（仅用于日志） */
  getActiveCount(): number {
    return this.sessions.size
  }
}
