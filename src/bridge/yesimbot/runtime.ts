/**
 * YesImBot ToolService 兼容类型与工厂辅助。
 *
 * YesImBot（npm 发布版 koishi-plugin-yesimbot@3.x）中的工具系统核心是
 * ToolService（"yesimbot.tool"），而不是 monorepo 里的 ExtensionService
 *（"yesimbot.extension"）。
 *
 * 工具注册链路：
 *   ctx["yesimbot.tool"].register(extensionInstance, enabled, config)
 *     → extensions Map                              ← extension.list 从此读
 *     → tools Map                                   ← LLM 工具调用从此查
 *       → tool.execute({ session, ...params })
 *          → { status: "success"|"error", result|error }
 *
 * 与 sticker-manager 使用相同的注册方式。
 */

// ---------------------------------------------------------------------------
// ToolService 接口
// ---------------------------------------------------------------------------

export interface ToolServiceLike {
  register(extensionInstance: ExtensionInstanceLike, enabled: boolean, config?: unknown): void
  unregister(name: string): boolean
}

// ---------------------------------------------------------------------------
// 扩展实例类型
// ---------------------------------------------------------------------------

export interface ExtensionMetadataLike {
  name: string
  display?: string
  description?: string
  author?: string
  version?: string
  builtin?: boolean
}

export interface ExtensionInstanceLike {
  metadata: ExtensionMetadataLike
  tools: Map<string, ToolDefinitionForToolService>
}

// ---------------------------------------------------------------------------
// 工具定义（ToolService 格式）
// ---------------------------------------------------------------------------

export interface ToolDefinitionForToolService {
  name: string
  description: string
  parameters?: unknown // Koishi Schema 对象
  execute: (args: { session: ToolSessionLike; [key: string]: unknown }) => Promise<ToolExecuteResult>
  isSupported?: (session: unknown) => boolean
  promptSnippet?: string
  promptGuidelines?: string[]
}

// ---------------------------------------------------------------------------
// 工具执行结果
// ---------------------------------------------------------------------------

export type ToolExecuteResult = ToolExecuteSuccess | ToolExecuteError

export interface ToolExecuteSuccess {
  status: 'success'
  result: unknown
  metadata?: unknown
}

export interface ToolExecuteError {
  status: 'error'
  error: {
    name: string
    message: string
    retryable?: boolean
  }
  metadata?: unknown
}

// ---------------------------------------------------------------------------
// Session（从 ToolService 调用中传入）
// ---------------------------------------------------------------------------

export interface ToolSessionLike {
  userId: string
  username?: string
  channelId?: string
  guildId?: string
  platform?: string
  isDirect?: boolean
  content?: string
  timestamp?: number
  [key: string]: unknown
}
