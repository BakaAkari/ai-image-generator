import { Context, Schema } from 'koishi'
import path from 'node:path'

import { ChatLunaBridgeManager } from './bridge/chatluna/manager.js'
import { ImageCatalogService } from './catalog/image-catalog.js'
import { registerConsoleService } from './console/service.js'
import type { ActiveSupplier } from './catalog/types.js'
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

  // 3b. 动态模型目录 —— 按激活供应商拉取模型清单 + 计价
  const catalog = new ImageCatalogService(ctx, logger, dataDir)

  // 目录 → service：计价自动换算 + 映射校验
  service.catalogPricingLookup = (modelId: string) => {
    const model = catalog.current?.models.find(m => m.id === modelId)
    return model?.pricing
  }

  // Schema.dynamic 选项源：模型映射的 modelId 下拉来自动态目录。
  // 机制同 chatluna：ctx.schema.set(name, Schema.union(...))，目录刷新后重建。
  const updateModelOptions = () => {
    const models = catalog.current?.models ?? []
    if (!models.length) {
      logger.info('schema dynamic source: skip (empty catalog)')
      return
    }
    if (!(ctx as any).schema) {
      logger.warn('schema dynamic source: ctx.schema service unavailable')
      return
    }
    try {
      ctx.schema.set(
        'image-generator.models',
        Schema.union(models.map(m =>
          Schema.const(m.id).description(
            m.pricing.type === 'per-call' && m.pricing.pricePerCall != null
              ? `${m.id}（$${m.pricing.pricePerCall.toFixed(3)}/次）`
              : m.pricing.type === 'per-token'
                ? `${m.id}（token 计费 ×${m.pricing.tokenRatio ?? '?'}）`
                : m.id,
          )
        )),
      )
      logger.info('schema dynamic source registered: image-generator.models (%d options, store keys: %s)',
        models.length, Object.keys((ctx as any).schema._data ?? {}).join(','))
    } catch (err) {
      logger.warn('schema dynamic source register failed: %s', err)
    }
  }

  // 目录刷新后：重校验映射，失效时告警
  const revalidate = () => {
    const models = catalog.current?.models ?? []
    if (!models.length) return
    const invalid = service.revalidateMappings(models)
    if (invalid.length) {
      logger.warn('模型映射校验：%d 个映射在当前供应商目录中不可用：%s', invalid.length, invalid.join('、'))
    } else {
      logger.info('模型映射校验通过：全部映射在当前供应商目录中可用')
    }
  }

  const resolveCredentials = (config: Config) => {
    const supplier: ActiveSupplier = config.activeSupplier ?? 'yunwu'
    const s = config.providerSettings
    if (supplier === 'yunwu' || supplier === 'gptgod') {
      const apiKey = s?.openaiCompatibleApiKey || config.openaiCompatibleApiKey || ''
      const defaultBase = supplier === 'yunwu' ? 'https://yunwu.ai/v1' : 'https://gptgod.cloud/v1'
      const apiBase = s?.openaiCompatibleApiBase || config.openaiCompatibleApiBase || defaultBase
      if (!apiKey) return null
      return {
        supplier,
        apiBase,
        apiKey,
        timeoutSec: config.apiTimeout ?? 60,
        refreshHours: config.catalogRefreshHours ?? 6,
        extraHeaders: s?.openaiCompatibleExtraHeaders || config.openaiCompatibleExtraHeaders,
      }
    }
    if (supplier === 'openai-official') {
      const apiKey = s?.gptOfficialApiKey || config.gptOfficialApiKey || ''
      if (!apiKey) return null
      return {
        supplier,
        apiBase: 'https://api.openai.com',
        apiKey,
        timeoutSec: config.apiTimeout ?? 60,
        refreshHours: config.catalogRefreshHours ?? 6,
      }
    }
    // gemini-official：目录拉取协议不同（/v1beta/models），M1 暂不支持
    return null
  }

  // 包装 refresh：每次刷新完成后重校验映射
  const origRefresh = catalog.refresh.bind(catalog)
  catalog.refresh = (cfg) => origRefresh(cfg).then((snap) => { revalidate(); updateModelOptions(); return snap })

  updateModelOptions()

  // aka-tools 面板后端服务（console 可用时注册）
  ctx.inject(['console'], (ctx) => {
    registerConsoleService({
      ctx,
      logger,
      catalog,
      getConfig: () => currentConfig,
      refreshCatalog: async () => {
        const cred = resolveCredentials(currentConfig)
        if (cred) await catalog.refresh(cred)
      },
    })
  })

  catalog.start(() => {
    const cred = resolveCredentials(currentConfig)
    if (!cred) {
      logger.debug('model catalog: no credentials for active supplier, skip refresh')
      return {
        supplier: currentConfig.activeSupplier ?? 'yunwu',
        apiBase: '',
        apiKey: '',
        timeoutSec: 60,
        refreshHours: currentConfig.catalogRefreshHours ?? 6,
      }
    }
    return cred
  })

  // 4. 命令族
  const commands = registerAllCommands({
    ctx,
    service,
    handlers,
    getConfig: () => currentConfig,
    catalogParams: {
      ctx,
      catalog,
      userManager,
      getConfig: () => currentConfig,
      resolveCredentials,
    },
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
    const prevCred = resolveCredentials(currentConfig)
    const nextCred = resolveCredentials(next)
    currentConfig = next
    service.updateConfig(next)
    // 供应商或凭证变化时立即刷新目录
    if (nextCred && JSON.stringify(prevCred) !== JSON.stringify(nextCred)) {
      void catalog.refresh(nextCred)
    }
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
