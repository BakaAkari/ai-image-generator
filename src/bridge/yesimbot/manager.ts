/**
 * YesImBot 桥接管理器（ToolService 路径）。
 *
 * 负责：
 * - 获取 ctx["yesimbot.tool"] (ToolService)
 * - 构造扩展实例（含 metadata + tools Map）
 * - 通过 toolService.register(instance, enabled, config) 注册工具
 * - 同步 enabled/disabled 状态并处理热重载
 *
 * 改造说明（0.8.5）：
 *   之前的实现错误地使用了 "yesimbot.extension" (ExtensionService) —
 *   该服务仅存在于 monorepo 的 core 中，npm 发布的 koishi-plugin-yesimbot@3.x
 *   根本不包含此服务。正确路径是 "yesimbot.tool" (ToolService)，
 *   与 sticker-manager 使用完全相同的注册方式。
 *
 * 与 sticker-manager 的差异：
 *   - sticker-manager 使用 @Extension/@Tool 装饰器自动注册
 *   - 本 bridge 手动构造 ExtensionInstanceLike 并调用 register()
 *   - 结果完全一致：extension.list 可见，LLM 可调用
 */

import type { Context } from 'koishi'

import type { AiImageGeneratorService } from '../../service/AiImageGeneratorService.js'
import type { Config } from '../../shared/config.js'
import { YESIMBOT_BRIDGE_EXTENSION_ID } from '../../shared/constants.js'
import type {
  ExtensionInstanceLike,
  ToolServiceLike,
} from './runtime.js'
import { createYesImBotExtensionInstance } from './tools.js'

export class YesImBotBridgeManager {
  private toolService: ToolServiceLike | null = null
  private extensionInstance: ExtensionInstanceLike | null = null
  private isRegistered = false
  private warnedUnavailable = false
  private syncQueue: Promise<void> = Promise.resolve()
  private readyDispose: (() => void) | null = null

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
          this.logger.info('YesImBot bridge sync: enabled=true, starting enable()')
          await this.enable()
        } else {
          this.logger.info('YesImBot bridge sync: enabled=false, skipping registration')
          await this.disable()
        }
      })
    return this.syncQueue
  }

  async dispose() {
    if (this.readyDispose) {
      this.readyDispose()
      this.readyDispose = null
    }
    await this.disable()
  }

  private async enable() {
    // 先清理之前的 ready 监听器（避免重入时重复注册）
    if (this.readyDispose) {
      this.readyDispose()
      this.readyDispose = null
    }
    this.warnedUnavailable = false

    // 1. 获取 ToolService（此时 YesImBot 的 start() 可能尚未完成，ToolService 可能为 null）
    const toolService = this.getToolService()
    if (toolService) {
      this.logger.info('YesImBot ToolService found immediately, proceeding with registration')
      await this.doRegister(toolService)
      return
    }

    // 2. ToolService 尚未就绪 —— 通过 ctx.on("ready") 等待所有插件初始化完毕后再重试。
    //    这与 sticker-manager 的 @Extension 装饰器使用相同的 ctx.on("ready", ...) 策略。
    this.logger.info(
      'YesImBot ToolService not ready yet (ctx["yesimbot.tool"] is null). ' +
      'Waiting for "ready" event (all plugins initialized) before retrying registration.',
    )
    this.readyDispose = this.ctx.on('ready', () => {
      this.readyDispose = null
      // ready 事件在同步回调中触发 —— 此时所有 Service.start() 已完成
      const service = this.getToolService()
      if (!service) {
        this.logger.warn(
          'YesImBot bridge: "ready" event fired but "yesimbot.tool" service still not available. ' +
          'Make sure koishi-plugin-yesimbot is installed and enabled.',
        )
        this.warnedUnavailable = true
        return
      }
      void this.doRegister(service)
    })
  }

  private async doRegister(toolService: ToolServiceLike) {
    // 如果已注册，跳过
    if (this.isRegistered) {
      this.logger.info('YesImBot bridge already registered, skipping re-registration')
      return
    }

    // 创建扩展实例（以获取最新 config 和 style 列表）
    this.logger.info('Creating YesImBot extension instance with %d tools configured',
      this.config.yesimbotExposeQuotaTool !== false ? 'all' : 'filtered')
    this.extensionInstance = createYesImBotExtensionInstance(
      this.aiGenerator,
      this.config,
      (...args: any[]) => {
        this.logger.info(`[yesimbot-bridge] ${args[0]}`, ...args.slice(1))
      },
    )
    this.logger.info('Extension instance created with %d tools in tools Map',
      this.extensionInstance.tools.size)

    // 注册到 ToolService
    this.logger.info(
      'Calling toolService.register() for extension "%s" (display: "%s")',
      this.extensionInstance.metadata.name,
      this.extensionInstance.metadata.display,
    )
    toolService.register(this.extensionInstance, true)
    this.toolService = toolService
    this.isRegistered = true

    this.logger.info(
      'YesImBot bridge enabled. Extension "%s" registered in ToolService. ' +
      'Run "extension.list" to verify.',
      YESIMBOT_BRIDGE_EXTENSION_ID,
    )
  }

  private async disable() {
    if (!this.isRegistered || !this.toolService) {
      return
    }

    this.toolService.unregister(YESIMBOT_BRIDGE_EXTENSION_ID)
    this.toolService = null
    this.extensionInstance = null
    this.isRegistered = false

    this.logger.info('YesImBot bridge disabled.')
  }

  private getToolService(): ToolServiceLike | null {
    // "yesimbot.tool" 是 YesImBot 的 ToolService (services/extension/service.js)，
    // 通过 super(ctx, "yesimbot.tool") 注册为 Koishi Service。
    //
    // inject.optional 中已声明 'yesimbot.tool'，Koishi Proxy 会放行此访问路径。
    //
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (this.ctx as any)['yesimbot.tool']
    if (!raw) {
      this.logger.info(
        'getToolService: ctx["yesimbot.tool"] is null/undefined. ' +
        'Is koishi-plugin-yesimbot installed and loaded before this plugin?',
      )
      return null
    }

    const service = raw as ToolServiceLike
    if (
      typeof service.register === 'function' &&
      typeof service.unregister === 'function'
    ) {
      this.logger.info('getToolService: ctx["yesimbot.tool"] found and verified (has register/unregister)')
      return service
    }

    // 诊断：服务存在但 API 不匹配
    this.logger.info(
      'getToolService: ctx["yesimbot.tool"] exists but lacks register/unregister. ' +
      'typeof=%s keys=%s',
      typeof raw,
      Object.keys(raw).join(','),
    )
    return null
  }
}
