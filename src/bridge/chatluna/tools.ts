/**
 * ChatLuna 工具注册（V2 积分制适配版）。
 *
 * 将 AI_GENERATOR_TOOL_DEFINITIONS 中定义的基础工具 + 用户配置的风格预设
 * 逐个注册为 ChatLuna 可调用的 LangChain StructuredTool。
 */

import { AI_GENERATOR_TOOL_DEFINITIONS } from '../../shared/chatluna-tool-definitions.js'
import type { ResolvedStyleConfig } from '../../shared/types.js'
import type { AiImageGeneratorService } from '../../service/AiImageGeneratorService.js'
import { createChatLunaToolInstance, createStylePresetToolInstance } from './tool-runtime.js'
import type { ChatLunaPluginLike, StructuredToolConstructor } from './runtime.js'
import type { ChatLunaConfigAccessor, ChatLunaSessionLike } from './types.js'

export function registerChatLunaTools(
  plugin: ChatLunaPluginLike,
  StructuredTool: StructuredToolConstructor,
  aiGenerator: AiImageGeneratorService,
  getConfig: ChatLunaConfigAccessor,
  styles: ResolvedStyleConfig[] = [],
) {
  // 注册基础工具
  for (const definition of AI_GENERATOR_TOOL_DEFINITIONS) {
    plugin.registerTool(definition.name, {
      selector() {
        return true
      },
      authorization(session: ChatLunaSessionLike) {
        return Boolean(session?.userId)
      },
      createTool() {
        return createChatLunaToolInstance(
          StructuredTool,
          definition,
          aiGenerator,
          getConfig,
        )
      },
    })
  }

  // 为用户配置的每个 style 注册独立工具
  for (const style of styles) {
    const toolName = `aigc_style_${sanitizeToolName(style.commandName)}`
    plugin.registerTool(toolName, {
      selector() {
        return true
      },
      authorization(session: ChatLunaSessionLike) {
        return Boolean(session?.userId)
      },
      createTool() {
        return createStylePresetToolInstance(
          StructuredTool,
          style,
          aiGenerator,
          getConfig,
        )
      },
    })
  }
}

function sanitizeToolName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_\u4e00-\u9fff]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '')
}
