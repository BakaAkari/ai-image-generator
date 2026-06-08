/**
 * YesImBot 运行时动态加载器。
 *
 * 通过 createRequire + 动态 import 双通道加载 @yesimbot/agent/ai，
 * 避免将 koishi-plugin-yesimbot 设为硬依赖。
 */

import { createRequire } from 'node:module'

export interface ExtensionServiceLike {
  registerExtension(definition: ExtensionDefinitionLike): void
  unregisterExtension(id: string): void
}

export interface ExtensionDefinitionLike {
  id: string
  order?: number
  setup(api: ExtensionAPILike): void | ExtensionCleanupLike | Promise<void | ExtensionCleanupLike>
}

export interface ExtensionAPILike {
  registerTool(tool: ToolDefinitionLike): void
  unregisterTool(name: string): void
  on(event: string, handler: (...args: any[]) => any): void
  sendMessage(message: unknown, options?: unknown): void
  sendUserMessage(content: string, options?: unknown): void
  events: unknown
}

export interface ToolDefinitionLike {
  name: string
  description: string
  inputSchema: unknown
  promptSnippet?: string
  promptGuidelines?: string[]
  execute(params: unknown, context: ToolExecutionContextLike): Promise<unknown>
}

export interface ToolExecutionContextLike {
  toolCallId: string
  messages: unknown[]
  abortSignal?: AbortSignal
  experimental_context: ExtensionContextLike
}

export interface ExtensionContextLike {
  cwd: string
  sessionManager: unknown
  model: string
  isIdle(): boolean
  signal: AbortSignal
  abort(): void
  hasPendingMessages(): boolean
  getContextUsage(): unknown
  compact(options?: unknown): Promise<unknown>
  getSystemPrompt(): string
}

export interface ExtensionCleanupLike {
  dispose(): void | Promise<void>
}

const runtimeRequire = createRequire(`${process.cwd()}/package.json`)

export async function loadYesImBotRuntime(): Promise<{
  jsonSchema: (schema: unknown) => unknown
}> {
  const aiModule = await loadRuntimeModule('@yesimbot/agent/ai')

  const jsonSchema = aiModule.jsonSchema as ((schema: unknown) => unknown) | undefined

  if (!jsonSchema) {
    throw new Error('jsonSchema export not found from @yesimbot/agent/ai.')
  }

  return { jsonSchema }
}

async function loadRuntimeModule(specifier: string): Promise<Record<string, any>> {
  try {
    return runtimeRequire(specifier) as Record<string, any>
  } catch (requireError) {
    const dynamicImport = new Function('s', 'return import(s)') as (
      target: string,
    ) => Promise<Record<string, any>>
    return dynamicImport(specifier).catch((importError) => {
      const requireMessage =
        requireError instanceof Error ? requireError.message : String(requireError)
      const importMessage =
        importError instanceof Error ? importError.message : String(importError)
      throw new Error(
        `failed to load runtime module "${specifier}"; require: ${requireMessage}; import: ${importMessage}`,
      )
    })
  }
}
