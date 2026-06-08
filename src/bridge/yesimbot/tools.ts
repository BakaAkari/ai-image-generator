/**
 * YesImBot 扩展实例工厂（ToolService 格式）。
 *
 * 构造一个符合 ToolService.register() 要求的扩展实例，
 * 包含 metadata 和 tools Map，与 sticker-manager 的 @Extension/@Tool
 * 装饰器产生的结果一致。
 */

import type { AiImageGeneratorService } from '../../service/AiImageGeneratorService.js'
import type { Config } from '../../shared/config.js'
import { YESIMBOT_BRIDGE_EXTENSION_ID } from '../../shared/constants.js'
import type {
  ExtensionInstanceLike,
  ExtensionMetadataLike,
  ToolDefinitionForToolService,
} from './runtime.js'
import { YESIMBOT_TOOL_DEFINITIONS } from './tool-definitions.js'
import { createYesImBotToolForToolService } from './tool-runtime.js'

export function createYesImBotExtensionInstance(
  aiGenerator: AiImageGeneratorService,
  config: Config,
  logger: (...args: any[]) => void,
): ExtensionInstanceLike {
  const toolsToRegister = YESIMBOT_TOOL_DEFINITIONS.filter((def) => {
    if (def.name === 'aigc_get_quota' && !config.yesimbotExposeQuotaTool) {
      return false
    }
    if (def.name === 'aigc_list_styles' && !config.yesimbotExposeStyleListTool) {
      return false
    }
    return true
  })

  const tools = new Map<string, ToolDefinitionForToolService>()
  for (const definition of toolsToRegister) {
    const toolInstance = createYesImBotToolForToolService(
      definition,
      aiGenerator,
      config,
      logger,
    )
    tools.set(toolInstance.name, toolInstance)
    logger('YesImBot tool prepared: %s', definition.name)
  }

  const metadata: ExtensionMetadataLike = {
    name: YESIMBOT_BRIDGE_EXTENSION_ID,
    display: 'AI 图像生成',
    description: '提供 AI 图像生成功能，包括文生图、图生图、风格应用、积分查询和风格列表。',
    author: 'aka',
    version: '1.0.0',
  }

  return { metadata, tools }
}
