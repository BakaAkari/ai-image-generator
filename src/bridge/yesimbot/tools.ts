/**
 * YesImBot 工具注册。
 *
 * 在 setup() 中将 YESIMBOT_TOOL_DEFINITIONS 中定义的基础工具
 * 逐个注册到 YesImBot ExtensionAPI。
 */

import type { AiImageGeneratorService } from '../../service/AiImageGeneratorService.js'
import type { Config } from '../../shared/config.js'
import type { ExtensionAPILike } from './runtime.js'
import { YESIMBOT_TOOL_DEFINITIONS } from './tool-definitions.js'
import { createYesImBotToolInstance } from './tool-runtime.js'

export function registerYesImBotTools(
  api: ExtensionAPILike,
  aiGenerator: AiImageGeneratorService,
  config: Config,
  jsonSchema: (schema: unknown) => unknown,
  logger: (...args: any[]) => void,
): void {
  const toolsToRegister = YESIMBOT_TOOL_DEFINITIONS.filter((def) => {
    if (def.name === 'aigc_get_quota' && !config.yesimbotExposeQuotaTool) {
      return false
    }
    if (def.name === 'aigc_list_styles' && !config.yesimbotExposeStyleListTool) {
      return false
    }
    return true
  })

  for (const definition of toolsToRegister) {
    const toolInstance = createYesImBotToolInstance(
      definition,
      aiGenerator,
      config,
      jsonSchema,
      logger,
    )

    api.registerTool(toolInstance)
    logger('YesImBot tool registered: %s', definition.name)
  }
}
