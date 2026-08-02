import { Context, Schema } from 'koishi'
import path from 'node:path'

import { ChatLunaBridgeManager } from './bridge/chatluna/manager.js'
import { ImageCatalogService } from './catalog/image-catalog.js'
import { registerConsoleService } from './console/service.js'
import { mergeConfig, mergeGlobalRuntimeFields, readConfig, writeConfig } from './console/config-store.js'
import type { ActiveSupplier } from './catalog/types.js'
import { YesImBotBridgeManager } from './bridge/yesimbot/manager.js'
import { registerAllCommands } from './commands/index.js'
import { createImageGenerationHandlers } from './orchestrators/ImageGenerationOrchestrator.js'
import { createOpenAIProvider } from './providers/openai.js'
import { createGeminiProvider } from './providers/gemini.js'
import { createMjProvider } from './providers/midjourney.js'
import { ProviderRegistry } from './providers/registry.js'
import { AiImageGeneratorService } from './service/AiImageGeneratorService.js'
import { selectRouteForOperation } from './service/model-route-selection.js'
import { UserManager } from './services/UserManager.js'
import { WizardSessionManager } from './services/wizard-session.js'
import { getPromptTimeoutMs } from './shared/prompt-timeout.js'
import { createWizardHandler } from './wizard/wizard-handler.js'
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

/**
 * Resolve a path inside this installed package as a STRING path — without
 * following symlinks.
 *
 * Why we cannot use `require.resolve`: when the plugin is installed via
 * `npm link` or `file:` (npm 8+ default creates a symlink),
 * `node_modules/koishi-plugin-aka-ai-image-generator` is a symlink to the
 * source directory outside koishi-app's tree. Both `__dirname` and
 * `require.resolve('koishi-plugin-aka-ai-image-generator/package.json')`
 * transparently resolve the realpath and give us the source directory —
 * a path that neither starts with the koishi-app root nor contains the
 * substring `node_modules`. Koishi console's static-asset guard rejects it
 * with 403, so the client bundle never loads.
 *
 * Fix: walk up from `process.cwd()` (or a small set of candidate roots)
 * looking for `node_modules/koishi-plugin-aka-ai-image-generator/<subPath>`
 * via string concatenation only. `path.resolve` and `fs.existsSync` do NOT
 * dereference the symlink for existence-check purposes, so the resulting
 * string path contains `node_modules` and passes Koishi's guard. Fall back
 * to `__dirname` for the standalone-copy install case (npm publish tarball,
 * production Docker image, etc.).
 */
function resolvePackagePath(subPath: string): string {
  const fs = require('node:fs') as typeof import('node:fs')
  const pkgName = 'koishi-plugin-aka-ai-image-generator'

  const candidateRoots = [process.cwd(), __dirname]
  for (const start of candidateRoots) {
    let dir = start
    // Walk up looking for a node_modules that contains our package.
    // Bounded by filesystem root; typical depth is 1-3 levels.
    for (let i = 0; i < 10; i++) {
      const candidate = path.join(dir, 'node_modules', pkgName, subPath)
      if (fs.existsSync(candidate)) return candidate
      const parent = path.dirname(dir)
      if (parent === dir) break // reached filesystem root
      dir = parent
    }
  }

  // Fallback: standalone-copy install (e.g. published tarball). __dirname
  // points inside the package's own lib/ folder in this mode.
  return path.resolve(__dirname, '..', subPath)
}

// 模块级注册表实例（生命周期与插件模块一致）
const providerRegistry = new ProviderRegistry()

// 内置 Provider 注册（image-only：协议优先，不注册供应商别名）
providerRegistry.register('openai', createOpenAIProvider)
providerRegistry.register('gemini', createGeminiProvider)
providerRegistry.register('mj', createMjProvider)


export async function apply(ctx: Context, config: Config) {
  const logger = ctx.logger(name)

  // 业务字段以 settings.json 为持久化事实源（saved-wins）；apiTimeout / catalogRefreshHours /
  // logLevel 三个全局运行项归 Koishi 原插件设置页所有，config-store 在读取时会用
  // bootstrap 值覆盖 settings.json 中的旧值，确保 Koishi Config 页保存后重启仍生效。
  const persistedConfig = await readConfig(ctx, config)
  Object.assign(config, persistedConfig)

  // 1. UserManager —— 数据落盘目录走 ctx.baseDir/data/<plugin>
  const dataDir = path.join(ctx.baseDir, 'data', name)
  const userManager = new UserManager(dataDir, logger)
  void userManager.reconcileExpiredReservations(config).catch(error => {
    logger.warn('启动时预授权恢复失败：%s', error)
  })

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

  // 3b. 动态模型目录 —— 按激活供应商拉取模型清单 + 计价
  const catalog = new ImageCatalogService(ctx, logger, dataDir)

  // 目录只负责模型与 route；运行时自动定价完全读取 config.modelCostProbes。
  //
  // route 选择按 operation 精确匹配：文生图 → text-to-image；图生图/合成图 → image-edit
  // （若模型未声明 image-edit route，则回退到能表达图生图能力的 text-to-image / image-to-image）。
  // 不再固定取 routes[0]，防止 recognition/upload/video/未实现 MJ 动作错入 Imagine。
  service.catalogRouteLookup = (modelId, operation) => {
    const model = catalog.current?.models.find(m => m.id === modelId)
    return selectRouteForOperation(model, operation ?? 'text-to-image')
  }

  const handlers = createImageGenerationHandlers({
    ctx,
    service,
    userManager,
    logger,
    getConfig: () => currentConfig,
    catalog,
  })

  // ── Wizard 向导系统 ──────────────────────────────────────────────────────
  // 每步超时与 apiTimeout / 编排器等待提示一致（Bug 3.3）；会话键含频道（Bug 3.4）
  const wizardSessions = new WizardSessionManager(() => getPromptTimeoutMs(currentConfig))
  const wizardHandler = createWizardHandler({
    ctx,
    catalog,
    service,
    handlers,
    getConfig: () => currentConfig,
    wizardSessions,
  })
  // 中间件：拦截用户消息，驱动向导步骤
  ctx.middleware(wizardHandler.getMiddleware())
  // 定期清理过期会话
  const wizardCleanupTimer = setInterval(() => {
    wizardSessions.cleanup()
  }, 60_000)

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
              ? `${m.id}（${m.pricing.pricePerCall.toFixed(2)} 供应商积分/次）`
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

  // 目录刷新后：重校验映射
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
    const active = (config.activeSupplier ?? 'newapi') as string
    const s = config.providerSettings
    if (active === 'yunwu' || active === 'gptgod' || active === 'newapi') {
      const apiKey = s?.openaiCompatibleApiKey || config.openaiCompatibleApiKey || ''
      const defaultBase = active === 'gptgod' ? 'https://gptgod.cloud/v1' : active === 'yunwu' ? 'https://yunwu.ai/v1' : ''
      const apiBase = s?.openaiCompatibleApiBase || config.openaiCompatibleApiBase || defaultBase
      if (!apiKey) return null
      return {
        supplier: 'newapi' as ActiveSupplier,
        apiBase,
        apiKey,
        timeoutSec: config.apiTimeout ?? 60,
        refreshHours: config.catalogRefreshHours ?? 6,
        extraHeaders: s?.openaiCompatibleExtraHeaders || config.openaiCompatibleExtraHeaders,
        endpoints: config.supplierEndpoints,
        endpointAliases: config.endpointAliases,
      }
    }
    if (active === 'openai-official') {
      const apiKey = s?.gptOfficialApiKey || config.gptOfficialApiKey || ''
      if (!apiKey) return null
      return {
        supplier: 'openai-official' as ActiveSupplier,
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
    // 注册 client 扩展入口（prod 指向 koishi-console build 产物 dist/）
    const clientEntry = resolvePackagePath('client/index.ts')
    const prodEntry = resolvePackagePath('dist')

    const entry = (ctx as any).console.addEntry({
      dev: clientEntry,
      prod: prodEntry,
    })
    logger.info(
      'aka-tools console entry registered: id=%s prod=%s exists=%s',
      entry?.id, prodEntry,
      require('node:fs').existsSync(path.resolve(prodEntry, 'index.js')),
    )
    registerConsoleService({
      ctx,
      logger,
      catalog,
      getConfig: () => currentConfig,
      refreshCatalog: async () => {
        const cred = resolveCredentials(currentConfig)
        if (cred) await catalog.refresh(cred)
      },
      writeConfig: next => writeConfig(ctx, next),
      mergeConfig,
      applyConfig: next => applyRuntimeConfig(next),
    })
  })

  catalog.start(() => {
    const cred = resolveCredentials(currentConfig)
    if (!cred) {
      logger.debug('model catalog: no credentials for active supplier, skip refresh')
      return {
        supplier: 'newapi' as ActiveSupplier,
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
    wizardHandler,
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

  // 7. 统一运行态更新：保存 settings.json 后原地更新 Koishi 注入的 config 对象。
  // 不调用 scope.update，避免 YAML 与 JSON 两个持久化事实源互相覆盖。
  const applyRuntimeConfig = (next: Config) => {
    const prevCred = resolveCredentials(currentConfig)
    Object.assign(config, next)
    currentConfig = config
    const nextCred = resolveCredentials(currentConfig)
    service.updateConfig(currentConfig)
    catalog.updateRefreshHours(currentConfig.catalogRefreshHours ?? 6)
    // 供应商或凭证变化时立即刷新目录；仅间隔变化由 scheduler 热更新处理。
    if (nextCred && JSON.stringify(prevCred) !== JSON.stringify(nextCred)) {
      void catalog.refresh(nextCred)
    }
    commands.image.refreshStyleCommands()
    chatLunaBridgeManager.updateConfig(currentConfig)
    if ((ctx as Context & { chatluna?: unknown }).chatluna) {
      void chatLunaBridgeManager.sync(currentConfig.chatlunaEnabled)
    }
    yesimbotBridgeManager.updateConfig(currentConfig)
    void yesimbotBridgeManager.sync(currentConfig.yesimbotEnabled)
  }

  // Koishi 原插件设置页只拥有 apiTimeout/catalogRefreshHours/logLevel；其它字段
  // 归 settings.json 所有。ctx.accept 会拿到完整（且带默认值）的 Config，
  // 因此必须先用 mergeGlobalRuntimeFields 剥掉业务字段，再喂给 applyRuntimeConfig，
  // 避免 Koishi 默认值覆盖 aka-tools 面板已保存的运行态。
  ctx.accept((next: Config) => applyRuntimeConfig(mergeGlobalRuntimeFields(currentConfig, next)))

  // 8. 插件卸载时的清理
  ctx.on('dispose' as any, async () => {
    catalog.stop()
    clearInterval(wizardCleanupTimer)
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
