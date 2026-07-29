import type { Session } from 'koishi'

/** 交互模式。auto 表示按会话类型自动切换：群聊 → 高级，私聊 → 引导。 */
export type InteractionMode = 'auto' | 'guided' | 'advanced'

/**
 * 按平台覆盖的交互模式映射。key 为 platform 标识（如 'lark'、'onebot'、'qq'），
 * value 为交互模式。未列出的平台使用全局 interactionMode。
 */
export type InteractionModeOverrides = Record<string, InteractionMode>

/**
 * 判断会话是否为群聊。
 *
 * 判断优先级（由高到低）：
 * 1. session.isDirect === true → 私聊
 * 2. session.isDirect === false → 群聊
 * 3. session.guildId 存在 → 群聊（兼容飞书等 adapter 在群聊中设置 guildId）
 * 4. session.channelId 存在且不等于 userId → 群聊（极简 fallback）
 * 5. 否则 → 私聊
 */
export function isGroupChat(session?: Session | null): boolean {
  if (!session) return false
  // 优先使用 isDirect
  if (session.isDirect === true) return false
  if (session.isDirect === false) return true
  // fallback：guildId 或 channelId ≠ userId
  if (session.guildId) return true
  if (session.channelId && session.channelId !== session.userId) return true
  return false
}

export interface ResolveInteractionModeOptions {
  /**
   * 本次消息是否已识别为「直接生成命令语法」（模型后缀 / 分辨率 / 比例 / -add / -n）。
   * 仅在 auto 模式下起作用：命中即视作用户想直接生成，覆盖私聊默认走向导的规则。
   * guided 与 advanced 模式对该字段免疫，行为不变。
   */
  hasDirectIntent?: boolean
}

/**
 * 根据配置和会话类型解析实际交互模式。
 *
 * 解析优先级：
 * 1. 如果 session.platform 在 overrides 中有配置，以 overrides[platform] 为准。
 * 2. 否则以全局 mode 为准。
 *
 * mode 语义：
 * - advanced: 无论会话类型都走高级直接生成。
 * - guided: 无论会话类型都走引导模式（即使命令行带模型后缀 / 参数语法也保持向导）。
 * - auto:
 *    - 命中「直接命令语法」（options.hasDirectIntent === true）→ advanced；
 *    - 否则回退到会话默认：群聊 → advanced，私聊 → guided。
 */
export function resolveInteractionMode(
  mode: InteractionMode,
  overrides: InteractionModeOverrides | undefined,
  session?: Session | null,
  options?: ResolveInteractionModeOptions,
): 'advanced' | 'guided' {
  // 优先检查平台覆盖
  const platform = session?.platform
  let effective: InteractionMode = mode
  if (platform && overrides && typeof overrides === 'object' && platform in overrides) {
    const overrideMode = overrides[platform]
    if (overrideMode) effective = overrideMode
  }
  if (effective === 'advanced') return 'advanced'
  if (effective === 'guided') return 'guided'
  // auto：识别到直接命令语法 → 直接生成，忽略私聊默认走向导
  if (options?.hasDirectIntent) return 'advanced'
  return isGroupChat(session) ? 'advanced' : 'guided'
}
