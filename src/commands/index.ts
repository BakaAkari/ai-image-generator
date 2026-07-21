/**
 * V2 命令族注册入口。
 *
 * 当前阶段注册图像核心命令、账户命令、管理员运营命令与帮助命令。
 */

import type { Context } from 'koishi'

import type { Config } from '../shared/config.js'
import type { ImageGenerationHandlers } from '../orchestrators/ImageGenerationOrchestrator.js'
import type { AiImageGeneratorService } from '../service/AiImageGeneratorService.js'

import { registerCatalogCommands, type RegisterCatalogCommandsParams } from './catalog.js'
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

export function registerAllCommands(
  params: RegisterAllCommandsParams & { catalogParams?: RegisterCatalogCommandsParams },
): RegisteredAllCommands {
  const image = registerImageCommands(params)
  registerHelpCommands(params)
  if (params.catalogParams) registerCatalogCommands(params.catalogParams)
  return { image }
}
