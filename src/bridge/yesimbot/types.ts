/**
 * YesImBot 桥接类型适配。
 *
 * 为 YesImBot 的 ExtensionContext 和事件定义轻量类型，
 * 避免直接依赖 @yesimbot/agent 的类型定义。
 */

export interface YesImBotSessionLike {
  userId: string
  username?: string
  channelId: string
  guildId?: string
  platform: string
  isDirect: boolean
  content: string
  timestamp: number
}

export interface YesImBotContextEventLike {
  type: 'context:build'
  messages: unknown[]
}

export interface YesImBotToolCallEventLike {
  type: 'tool:call'
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

export interface YesImBotToolResultEventLike {
  type: 'tool:result'
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  content: unknown
  details: unknown
  isError: boolean
}
