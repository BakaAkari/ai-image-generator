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

/**
 * 根据配置和会话类型解析实际交互模式。
 *
 * 解析优先级：
 * 1. 如果 session.platform 在 overrides 中有配置，以 overrides[platform] 为准。
 * 2. 否则以全局 mode 为准。
 *
 * mode 语义：
 * - advanced: 无论会话类型都走高级直接生成。
 * - guided: 无论会话类型都走引导模式。
 * - auto: 群聊 → advanced，私聊 → guided。
 */
export function resolveInteractionMode(
  mode: InteractionMode,
  overrides: InteractionModeOverrides | undefined,
  session?: Session | null,
): 'advanced' | 'guided' {
  // 优先检查平台覆盖
  const platform = session?.platform
  if (platform && overrides && typeof overrides === 'object' && platform in overrides) {
    const overrideMode = overrides[platform]
    if (overrideMode === 'advanced') return 'advanced'
    if (overrideMode === 'guided') return 'guided'
    // overrideMode === 'auto' → 按会话类型判断
    return isGroupChat(session) ? 'advanced' : 'guided'
  }
  // 全局模式
  if (mode === 'advanced') return 'advanced'
  if (mode === 'guided') return 'guided'
  return isGroupChat(session) ? 'advanced' : 'guided'
}
