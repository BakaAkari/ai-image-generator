/**
 * V2 命令族注册入口。
 *
 * 当前阶段注册图像核心命令（文生图 / 图生图 / 额度查询）与帮助命令。
 */

import type { Context } from 'koishi'

import type { Config } from '../shared/config.js'
import type { ImageGenerationHandlers } from '../orchestrators/ImageGenerationOrchestrator.js'
import type { AiImageGeneratorService } from '../service/AiImageGeneratorService.js'

import { registerHelpCommands } from './help.js'
import { registerImageCommands } from './image.js'
import type { RegisteredImageCommands } from './image.js'

export interface RegisterAllCommandsParams {
  ctx: Context
  service: AiImageGeneratorService
  handlers: ImageGenerationHandlers
  getConfig: () => Config
}

export interface RegisteredAllCommands {
  image: RegisteredImageCommands
}

export function registerAllCommands(params: RegisterAllCommandsParams): RegisteredAllCommands {
  const image = registerImageCommands(params)
  registerHelpCommands(params)
  return { image }
}
