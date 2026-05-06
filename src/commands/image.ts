/**
 * MVP 命令族：文生图 / 图生图 / 额度查询。
 *
 * 设计要点：
 * - 仅注册 3 条核心命令，对应 V2 MVP 阶段。
 * - 解析 `parseStyleCommandModifiers` 返回的 modifiers，由 Service 转换为
 *   `ImageRequestContext + GenerationDisplayInfo`，Orchestrator 不感知 modifier 细节。
 * - 命令前缀使用 `aig` 以与 v1 `ai`/`aig` 系命令隔离，方便双插件并存。
 */

import type { Argv, Context, Session } from 'koishi'
import { h } from 'koishi'

import type { Config } from '../shared/config.js'
import { COMMANDS } from '../shared/constants.js'
import type { ImageGenerationHandlers } from '../orchestrators/ImageGenerationOrchestrator.js'
import type { AiImageGeneratorService } from '../service/AiImageGeneratorService.js'
import {
  buildModelMappingIndex,
  parseStyleCommandModifiers,
} from '../utils/parser.js'

export interface RegisterImageCommandsParams {
  ctx: Context
  service: AiImageGeneratorService
  handlers: ImageGenerationHandlers
  getConfig: () => Config
}

export function registerImageCommands(params: RegisterImageCommandsParams) {
  const { ctx, service, handlers, getConfig } = params

  // ---------------------------------------------------------------------------
  // 文生图：aig.文生图 [-1k|-16:9|-add ...] <prompt:text>
  // ---------------------------------------------------------------------------
  ctx.command(`aig.${COMMANDS.TXT_TO_IMG} [prompt:text]`, '文生图')
    .alias('aig.t2i')
    .action(async (argv: Argv, prompt?: string) => {
      const session = argv.session
      if (!session) return ''

      const config = getConfig()
      const modelIndex = buildModelMappingIndex(config.modelMappings)
      const modifiers = parseStyleCommandModifiers(argv, undefined, modelIndex)

      const setup = service.buildGenerationSetup(
        config.defaultNumImages || 1,
        modifiers,
      )

      return handlers.executeTextToImage(
        session,
        prompt,
        setup.requestContext,
        setup.displayInfo,
      )
    })

  // ---------------------------------------------------------------------------
  // 图生图：aig.图生图 [-1k|-16:9|-add ...] [img] [prompt:text]
  // ---------------------------------------------------------------------------
  ctx.command(`aig.${COMMANDS.IMG_TO_IMG} [img] [prompt:text]`, '图生图')
    .alias('aig.i2i')
    .action(async (argv: Argv, img?: unknown, prompt?: string) => {
      const session = argv.session
      if (!session) return ''

      const config = getConfig()
      const modelIndex = buildModelMappingIndex(config.modelMappings)
      const modifiers = parseStyleCommandModifiers(argv, img, modelIndex)

      const setup = service.buildGenerationSetup(
        config.defaultNumImages || 1,
        modifiers,
      )

      return handlers.executeImageToImage(
        session,
        img,
        prompt,
        setup.requestContext,
        setup.displayInfo,
      )
    })

  // ---------------------------------------------------------------------------
  // 额度查询：aig.图像额度
  // ---------------------------------------------------------------------------
  ctx.command(`aig.${COMMANDS.QUERY_QUOTA}`, '查询当前额度')
    .alias('aig.quota')
    .action(async (argv: Argv) => {
      const session: Session | undefined = argv.session
      if (!session) return ''
      return handlers.executeQueryQuota(session)
    })
}

// h 在 Koishi 中按需用于发送消息片段；命令模块内部不直接发图，仅提供给将来扩展使用。
void h
