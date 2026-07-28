import type { Session } from 'koishi'

/** 交互模式。auto 表示按会话类型自动切换：群聊 → 高级，私聊 → 引导。 */
export type InteractionMode = 'auto' | 'guided' | 'advanced'

/**
 * 判断会话是否为群聊。
 * 使用 guildId 作为主要判断：有 guildId 就是群聊；
 * 如果没有 guildId 但有 channelId 且与 userId 不同，也视为群聊。
 */
export function isGroupChat(session?: Session | null): boolean {
  if (!session) return false
  if (session.guildId) return true
  if (session.channelId && session.channelId !== session.userId) return true
  return false
}

/**
 * 根据配置和会话类型解析实际交互模式。
 * - advanced: 无论会话类型都走高级直接生成。
 * - guided: 无论会话类型都走引导模式。
 * - auto: 群聊 → advanced，私聊 → guided。
 */
export function resolveInteractionMode(mode: InteractionMode, session?: Session | null): 'advanced' | 'guided' {
  if (mode === 'advanced') return 'advanced'
  if (mode === 'guided') return 'guided'
  return isGroupChat(session) ? 'advanced' : 'guided'
}
