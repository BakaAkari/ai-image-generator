import { Context } from 'koishi'
import path from 'node:path'

import { ChatLunaBridgeManager } from './bridge/chatluna/manager.js'
import { YesImBotBridgeManager } from './bridge/yesimbot/manager.js'
import { registerAllCommands } from './commands/index.js'
import { createImageGenerationHandlers } from './orchestrators/ImageGenerationOrchestrator.js'
import { createGeminiProvider } from './providers/gemini.js'
import { createOpenAIProvider } from './providers/openai.js'
import { ProviderRegistry } from './providers/registry.js'
import { AiImageGeneratorService } from './service/AiImageGeneratorService.js'
import { UserManager } from './services/UserManager.js'
import { Config as ConfigSchema } from './shared/config.js'
import type { Config as PluginConfig } from './shared/config.js'
import { PLUGIN_NAME } from './shared/constants.js'

/**
 * V2 插件入口（aka-ai-image-generator） —— 仅图像生成。
 *
 * Phase 4 MVP 接线：
 *   - ProviderRegistry：模块级单例，注册 2 个协议优先 image Provider 工厂
 *   - UserManager：用户积分 / 限流 / 安全计数（cherry-pick 自 v1）
 *   - AiImageGeneratorService：核心服务（Provider 实例化 + 积分 + 用量 + 图像记忆）
 *   - ImageGenerationOrchestrator：MVP 编排（文生图 + 图生图，命令级超时）
 *   - 命令族：文生图 / 图生图 / 合成图 / 图像查询 / 图像账单
 *
 * 配置热重载：通过 ctx.scope.update 风格的 acceptor 处理；本入口在变更时同步
 * 更新闭包内的 currentConfig，并调用 `service.updateConfig(next)`。
 *
 * 后续阶段计划只保留在文档中，当前运行时代码不暴露未实现功能的配置项。
 *
 * 注：本插件**不包含视频生成**功能，相关代码 / 配置 / 文档全部不在 v2 范围内。
 */
export const name = PLUGIN_NAME

// ChatLuna / YesImBot 可选依赖声明（不安装对应插件时仍可正常工作）
// 声明 optional 可让 Koishi 在加载此插件前先加载已安装的 yesimbot / chatluna，
// 避免首次启动时 ctx["yesimbot.tool"] 尚未注册的时序问题。
//
// "yesimbot": yesimbot 插件根上下文（提供 ctx.yesimbot 命名空间，帮助加载时序）
// "yesimbot.tool": YesImBot ToolService（register/unregister API，extensions/tools Map）
export const inject = {
  optional: ['chatluna', 'yesimbot', 'yesimbot.tool'],
} as const

// 暴露给 Koishi 的配置类型与 Schema（与 shared/config.ts 中的运行期 interface 对齐）
export type Config = PluginConfig
export const Config = ConfigSchema

// 模块级注册表实例（生命周期与插件模块一致）
const providerRegistry = new ProviderRegistry()

// 内置 Provider 注册（image-only：协议优先，不注册供应商别名）
providerRegistry.register('openai', createOpenAIProvider)
providerRegistry.register('gemini', createGeminiProvider)


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
  const commands = registerAllCommands({
    ctx,
    service,
    handlers,
    getConfig: () => currentConfig,
  })

  // 5. ChatLuna 桥接管理器
  const chatLunaBridgeManager = new ChatLunaBridgeManager(
    ctx,
    service,
    currentConfig,
    logger,
  )
  // 等待 chatluna 服务可用后再同步（避免在 chatluna 尚未加载时过早调用导致工具无法注册）
  ctx.inject(['chatluna'], async (ctx) => {
    await chatLunaBridgeManager.sync(currentConfig.chatlunaEnabled)
  })

  // 6. YesImBot 桥接管理器
  const yesimbotBridgeManager = new YesImBotBridgeManager(
    ctx,
    service,
    currentConfig,
    logger,
  )
  void yesimbotBridgeManager.sync(currentConfig.yesimbotEnabled)

  // 7. 配置热重载兼容
  ctx.accept((next: Config) => {
    currentConfig = next
    service.updateConfig(next)
    commands.image.refreshStyleCommands()
    chatLunaBridgeManager.updateConfig(next)
    // 只在 chatluna 服务可用时同步（热重载场景）
    if ((ctx as Context & { chatluna?: unknown }).chatluna) {
      void chatLunaBridgeManager.sync(next.chatlunaEnabled)
    }
    yesimbotBridgeManager.updateConfig(next)
    void yesimbotBridgeManager.sync(next.yesimbotEnabled)
  })

  // 8. 插件卸载时的清理
  ctx.on('dispose' as any, async () => {
    await chatLunaBridgeManager.dispose()
    await yesimbotBridgeManager.dispose()
  })

  const registered = providerRegistry.list()
  logger.info(
    'plugin=%s phase=4 status=protocol-mvp-ready providers=%s count=%d commands=%s chatluna=%s yesimbot=%s',
    name,
    registered.join(',') || '<none>',
    registered.length,
    '文生图,图生图,合成图,图像查询,图像账单,图像充值,图像排行榜',
    currentConfig.chatlunaEnabled ? 'enabled' : 'disabled',
    currentConfig.yesimbotEnabled ? 'enabled' : 'disabled',
  )
}
