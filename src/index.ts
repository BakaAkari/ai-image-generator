import { Context } from 'koishi'
import path from 'node:path'

import { registerAllCommands } from './commands/index.js'
import { createImageGenerationHandlers } from './orchestrators/ImageGenerationOrchestrator.js'
import { createGeminiProvider } from './providers/gemini.js'
import { createGptOfficialProvider } from './providers/gpt-official.js'
import { createGptGodProvider } from './providers/gptgod.js'
import { createGrokProvider } from './providers/grok.js'
import { createOpenAIImagesProvider } from './providers/openai-images.js'
import { ProviderRegistry } from './providers/registry.js'
import { createYunwuAdaptiveProvider } from './providers/yunwu-adaptive.js'
import { AiImageGeneratorService } from './service/AiImageGeneratorService.js'
import { UserManager } from './services/UserManager.js'
import { Config as ConfigSchema } from './shared/config.js'
import type { Config as PluginConfig } from './shared/config.js'
import { PLUGIN_NAME } from './shared/constants.js'

/**
 * V2 插件入口（aka-ai-image-generator） —— 仅图像生成。
 *
 * Phase 4 MVP 接线：
 *   - ProviderRegistry：模块级单例，注册 6 个 image-only Provider 工厂
 *   - UserManager：用户配额 / 限流 / 安全计数（cherry-pick 自 v1）
 *   - AiImageGeneratorService：核心服务（Provider 实例化 + 配额 + 用量 + 图像记忆）
 *   - ImageGenerationOrchestrator：MVP 编排（文生图 + 图生图，命令级超时）
 *   - 命令族：aig.文生图 / aig.图生图 / aig.图像额度
 *
 * 配置热重载：通过 ctx.scope.update 风格的 acceptor 处理；本入口在变更时同步
 * 更新闭包内的 currentConfig，并调用 `service.updateConfig(next)`。
 *
 * Phase 5 计划：
 *   - 迁移工具 + 文档（v1 → v2 用户数据迁移）
 *   - ChatLuna 桥接（manager/runtime/context-injection/tools）
 *   - 完整命令族：合成图、风格迁移、改姿势、修改设计、变像素、充值、参数指令
 *   - 发布到 npm
 *
 * 注：本插件**不包含视频生成**功能，相关代码 / 配置 / 文档全部不在 v2 范围内。
 */
export const name = PLUGIN_NAME

// 暴露给 Koishi 的配置类型与 Schema（与 shared/config.ts 中的运行期 interface 对齐）
export type Config = PluginConfig
export const Config = ConfigSchema

// 模块级注册表实例（生命周期与插件模块一致）
const providerRegistry = new ProviderRegistry()

// 内置 Provider 注册（image-only：6 个图像供应商，与 shared/config.ts 中的 Tagged Union 一一对应）
providerRegistry.register('openai-images', createOpenAIImagesProvider)
providerRegistry.register('openai', createOpenAIImagesProvider) // Schema 中的 provider 标签别名
providerRegistry.register('gemini', createGeminiProvider)
providerRegistry.register('gptgod', createGptGodProvider)
providerRegistry.register('grok', createGrokProvider)
providerRegistry.register('yunwu', createYunwuAdaptiveProvider) // Schema 中的标签
providerRegistry.register('yunwu-adaptive', createYunwuAdaptiveProvider) // 内部别名
providerRegistry.register('gpt-official', createGptOfficialProvider)

/**
 * 暴露给同插件其它模块（如未来的 ChatLuna bridge）的注册表入口。
 * 不通过 ctx.set() 暴露，避免污染全局服务命名空间。
 */
export function getProviderRegistry(): ProviderRegistry {
  return providerRegistry
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger(name)

  // 1. UserManager —— 数据落盘目录走 ctx.baseDir/data/<plugin>
  const dataDir = path.join(ctx.baseDir, 'data', name)
  const userManager = new UserManager(dataDir, logger)

  // 2. Service —— 注入 UserManager 与 ProviderRegistry
  // Service 基类构造函数会自动注册到 ctx（super(ctx, 'aiImageGenerator', true)），
  // 因此这里不需要再调用 ctx.plugin(service)。
  const service = new AiImageGeneratorService(
    ctx,
    config,
    userManager,
    providerRegistry,
  )

  // 3. Orchestrator —— 闭包持有 currentConfig，热重载时由 acceptor 覆盖
  let currentConfig = config
  const handlers = createImageGenerationHandlers({
    ctx,
    service,
    userManager,
    logger,
    getConfig: () => currentConfig,
  })

  // 4. 命令族
  registerAllCommands({
    ctx,
    service,
    handlers,
    getConfig: () => currentConfig,
  })

  // 5. 配置热重载兼容（7.11.6 节）
  ctx.accept((next: Config) => {
    currentConfig = next
    service.updateConfig(next)
  })

  const registered = providerRegistry.list()
  logger.info(
    'plugin=%s phase=4 status=mvp-ready providers=%s count=%d commands=%s',
    name,
    registered.join(',') || '<none>',
    registered.length,
    'aig.文生图,aig.图生图,aig.图像额度',
  )
}
