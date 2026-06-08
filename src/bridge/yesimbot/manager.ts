/**
 * YesImBot 桥接管理器。
 *
 * 负责：
 * - 动态加载 YesImBot 运行时（@yesimbot/agent/ai 的 jsonSchema）
 * - 注册 / 注销 YesImBot Extension（工具 + 上下文注入）
 * - 同步 enabled/disabled 状态并处理热重载
 *
 * 与 ChatLuna Bridge 的差异：
 * - 通过 ctx["yesimbot.extension"].registerExtension() 注册
 * - 工具在 setup() 中通过 api.registerTool() 注册
 * - 上下文注入通过 api.on("context:build", ...) 实现
 * - YesImBot 自动处理 session reload，无需手动 disable/enable
 */

import type { Context } from 'koishi'

import type { AiImageGeneratorService } from '../../service/AiImageGeneratorService.js'
import type { Config } from '../../shared/config.js'
import { YESIMBOT_BRIDGE_EXTENSION_ID } from '../../shared/constants.js'
import { installYesImBotContextInjection } from './context-injection.js'
import { loadYesImBotRuntime } from './runtime.js'
import type {
  ExtensionCleanupLike,
  ExtensionDefinitionLike,
  ExtensionServiceLike,
} from './runtime.js'
import { registerYesImBotTools } from './tools.js'

export class YesImBotBridgeManager {
  private extensionService: ExtensionServiceLike | null = null
  private isRegistered = false
  private warnedUnavailable = false
  private syncQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly ctx: Context,
    private readonly aiGenerator: AiImageGeneratorService,
    private config: Config,
    private readonly logger: ReturnType<Context['logger']>,
  ) {}

  updateConfig(config: Config) {
    this.config = config
  }

  sync(enabled: boolean) {
    this.syncQueue = this.syncQueue
      .catch(() => {})
      .then(async () => {
        if (enabled) {
          // YesImBot 的 ExtensionRunner 会在每次 session reload 时
          // 重新调用 setup()，所以即使已注册，新增的 style 工具也会自动加载。
          // 但为了确保首次启用时正确注册，这里始终调用 enable()
          this.logger.info('YesImBot bridge sync: enabled=true, starting enable()')
          await this.enable()
        } else {
          this.logger.info('YesImBot bridge sync: enabled=false (config yesimbotEnabled is off), skipping registration')
          await this.disable()
        }
      })
    return this.syncQueue
  }

  async dispose() {
    await this.disable()
  }

  private async enable() {
    // 每次 enable() 调用都重置诊断状态，确保热重载后重试时能看到日志
    this.warnedUnavailable = false

    // 检查 YesImBot Extension Service 是否存在
    const extensionService = this.getExtensionService()
    if (!extensionService) {
      this.logger.warn(
        'YesImBot bridge enabled in config, but ctx["yesimbot.extension"] service is not available. ' +
        'Make sure koishi-plugin-yesimbot is installed, enabled, and loaded before this plugin. ' +
        'If you just installed yesimbot, restart Koishi so both plugins load in the correct order.',
      )
      this.warnedUnavailable = true
      return
    }
    this.logger.info('YesImBot extension service found, proceeding with registration')

    // 如果已注册，跳过（YesImBot 会在 reload 时自动重新 setup）
    if (this.isRegistered) {
      this.logger.info('YesImBot bridge already registered, skipping re-registration')
      return
    }

    // 加载 YesImBot 运行时（jsonSchema）
    this.logger.info('Loading @yesimbot/agent/ai runtime module...')
    const runtime = await loadYesImBotRuntime().catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn(
        'YesImBot bridge failed to load @yesimbot/agent/ai runtime: %s. ' +
        'Make sure koishi-plugin-yesimbot (or yesimbot-core) is installed and its dependencies are resolved.',
        message,
      )
      this.warnedUnavailable = true
      return null
    })
    if (!runtime) return

    this.logger.info('runtime module loaded, creating ExtensionDefinition')

    // 创建 ExtensionDefinition
    const extensionDefinition: ExtensionDefinitionLike = {
      id: YESIMBOT_BRIDGE_EXTENSION_ID,
      order: 100,
      setup: (api) => {
        const logFn = (...args: any[]) => {
          this.logger.info(`[yesimbot-bridge] ${args[0]}`, ...args.slice(1))
        }

        logFn('setup() called, registering tools')

        // 注册工具（基础工具 + 风格预设工具）
        registerYesImBotTools(api, this.aiGenerator, this.config, runtime.jsonSchema, logFn)

        // 安装上下文注入
        installYesImBotContextInjection(api, this.aiGenerator, this.config, logFn)

        // 返回清理函数
        const cleanup: ExtensionCleanupLike = {
          dispose: () => {
            logFn('YesImBot bridge cleanup called')
          },
        }

        return cleanup
      },
    }

    // 注册 Extension
    this.logger.info('Calling extensionService.registerExtension()')
    extensionService.registerExtension(extensionDefinition)
    this.extensionService = extensionService
    this.isRegistered = true

    this.logger.info(
      'YesImBot bridge enabled. Extension "%s" registered successfully.',
      YESIMBOT_BRIDGE_EXTENSION_ID,
    )
  }

  private async disable() {
    if (!this.isRegistered || !this.extensionService) {
      return
    }

    this.extensionService.unregisterExtension(YESIMBOT_BRIDGE_EXTENSION_ID)
    this.extensionService = null
    this.isRegistered = false

    this.logger.info('YesImBot bridge disabled.')
  }

  private getExtensionService(): ExtensionServiceLike | null {
    try {
      // 使用 ctx.get() 而非 ctx["yesimbot.extension"]，因为 Koishi Context Proxy
      // 对点号 key 会触发属性校验（require inject declaration），
      // 而 inject 不支持嵌套 service 名。ctx.get() 则直接走内部 service 查找。
      const ctx = this.ctx as { get(name: string): unknown }
      const service = ctx.get('yesimbot.extension') as ExtensionServiceLike | undefined
      if (
        service &&
        typeof service.registerExtension === 'function' &&
        typeof service.unregisterExtension === 'function'
      ) {
        return service
      }
      return null
    } catch {
      return null
    }
  }
}
