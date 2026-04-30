import { Context, Schema } from 'koishi'
import { PLUGIN_NAME } from './shared/constants.js'
import type { Config as PluginConfig } from './shared/config.js'

/**
 * V2 插件入口（aka-ai-image-generator）
 *
 * Phase 1：仅占位脚手架，不注册任何命令、服务、Provider。
 * Phase 2-4 会在此处接入：
 *   - UserManager / AiImageGeneratorService（services 层）
 *   - ProviderRegistry + Image/Video Providers
 *   - Orchestrators（image / video / compose / migration）
 *   - Commands（aig.* 命令族）
 *   - Bridge（chatluna）
 *
 * Phase 3 会用 Tagged Union 重写 `Config` 为完整 Schema，并替换下面的占位。
 */
export const name = PLUGIN_NAME

// 暴露给 Koishi 的配置类型；与 shared/config.ts 中的运行期 interface 对齐
export type Config = PluginConfig

// Phase 1 占位 Schema：保持插件可加载，避免 Koishi 控制台报错
// Phase 3 替换为基于 Tagged Union 的完整 Schema 设计（详见 v2 架构文档 §13）
export const Config: Schema<Config> = Schema.object({}) as Schema<Config>

export function apply(ctx: Context, _config: Config) {
  const logger = ctx.logger(name)
  logger.info('plugin=%s phase=1 status=scaffold', name)
}
