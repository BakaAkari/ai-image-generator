/**
 * ChatLuna 桥接层类型定义（V2 适配版）。
 *
 * 这些接口描述了 ChatLuna 运行时会话、消息、prompt 变量的松散形状，
 * 避免在桥接代码中对 ChatLuna 内部类型产生硬依赖。
 */

import type { Config } from '../../shared/config.js'

/** 允许桥接层按需读取最新 Config 的函数，避免持有过期快照。 */
export type ChatLunaConfigAccessor = () => Config

/** ChatLuna 工具执行时传入的会话对象（松散类型）。 */
export interface ChatLunaSessionLike {
  userId?: string | null
  username?: string | null
  platform?: string | null
  content?: unknown
  quote?: {
    content?: unknown
    elements?: unknown[]
  }
  send?: (message: unknown) => Promise<unknown> | unknown
  author?: {
    name?: string | null
    nickname?: string | null
  }
}

/** ChatLuna human message 对象（松散类型）。 */
export interface ChatLunaHumanMessageLike {
  content: unknown
  name?: string | null
}

/** ChatLuna prompt variables 对象（松散类型）。 */
export interface ChatLunaPromptVariablesLike {
  aiGeneratorContext?: string
  aiGeneratorContextData?: unknown
  aiGeneratorStyleCandidates?: unknown[]
  aiGeneratorPreferredStylePreset?: string
  aiGeneratorReferenceRecommendation?: string
  input?: string
  userInput?: string
  conversationId?: string
  conversation_id?: string
  roomId?: string
  room_id?: string
  platform?: string
  [key: string]: unknown
}
