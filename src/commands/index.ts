/**
 * V2 命令族注册入口。
 *
 * MVP 阶段仅注册图像核心命令（文生图 / 图生图 / 额度查询）。
 * Phase 5 时按需新增：合成图、风格迁移、改姿势、修改设计、变像素、充值、参数指令等。
 */

import type { Context } from 'koishi'

import type { Config } from '../shared/config.js'
import type { ImageGenerationHandlers } from '../orchestrators/ImageGenerationOrchestrator.js'
import type { AiImageGeneratorService } from '../service/AiImageGeneratorService.js'

import { registerImageCommands } from './image.js'

export interface RegisterAllCommandsParams {
  ctx: Context
  service: AiImageGeneratorService
  handlers: ImageGenerationHandlers
  getConfig: () => Config
}

export function registerAllCommands(params: RegisterAllCommandsParams) {
  registerImageCommands(params)
}
