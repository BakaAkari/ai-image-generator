/**
 * ChatLuna 桥接管理器（V2 积分制适配版）。
 *
 * 负责：
 * - 动态加载 ChatLuna 运行时（koishi-plugin-chatluna + @langchain/core/tools）
 * - 注册 / 注销 ChatLuna 插件（工具 + 上下文注入）
 * - 同步 enabled/disabled 状态并处理热重载
 *
 * 关键 V2 适配：
 * - AiGeneratorService → AiImageGeneratorService
 * - listStylePresets() 返回 ResolvedStyleConfig[]
 * - CHATLUNA_BRIDGE_PLATFORM_NAME 在 constants.ts 中定义
 */

import type { Context } from 'koishi'

import type { AiImageGeneratorService } from '../../service/AiImageGeneratorService.js'
import { AI_GENERATOR_TOOL_DEFINITIONS } from '../../shared/chatluna-tool-definitions.js'
import type { Config } from '../../shared/config.js'
import { CHATLUNA_BRIDGE_PLATFORM_NAME } from '../../shared/constants.js'
import { installChatLunaContextInjection } from './context-injection.js'
import { loadChatLunaRuntime } from './runtime.js'
import type { ChatLunaPluginLike, ChatLunaServiceLike } from './runtime.js'
import { registerChatLunaTools } from './tools.js'

export class ChatLunaBridgeManager {
  private chatLunaPlugin?: ChatLunaPluginLike
  private contextInjectionDispose?: () => void
  private warnedUnavailable = false
  private syncQueue: Promise<void> = Promise.resolve()
  private readonly getConfig = () => this.config

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
          // 如果插件已经注册，先注销再重新注册，确保新增的 style 工具被加载
          if (this.chatLunaPlugin) {
            await this.disable()
          }
          await this.enable()
        } else {
          await this.disable()
        }
      })
    return this.syncQueue
  }

  async dispose() {
    await this.disable()
  }

  private async enable() {
    const chatlunaService = this.getChatLunaService()
    if (!chatlunaService) {
      if (!this.warnedUnavailable) {
        this.logger.warn(
          'ChatLuna bridge enabled, but ChatLuna service is not available. Install and enable ChatLuna first.',
        )
        this.warnedUnavailable = true
      }
      return
    }

    if (this.config.chatlunaContextInjectionEnabled && !this.contextInjectionDispose) {
      this.contextInjectionDispose = installChatLunaContextInjection(
        this.ctx,
        this.aiGenerator,
        this.getConfig,
        this.logger,
      )
    }
    if (!this.config.chatlunaContextInjectionEnabled && this.contextInjectionDispose) {
      this.contextInjectionDispose()
      this.contextInjectionDispose = undefined
    }

    if (this.chatLunaPlugin) {
      this.warnedUnavailable = false
      return
    }

    const runtime = await loadChatLunaRuntime().catch((error) => {
      if (!this.warnedUnavailable) {
        const message = error instanceof Error ? error.message : String(error)
        this.logger.warn(
          'ChatLuna bridge enabled but runtime modules are unavailable: %s',
          message,
        )
        this.warnedUnavailable = true
      }
      return null
    })
    if (!runtime) return

    const existing = chatlunaService.getPlugin?.(CHATLUNA_BRIDGE_PLATFORM_NAME)
    if (existing) {
      this.logger.warn(
        'ChatLuna plugin name "%s" is already in use, skip built-in bridge registration.',
        CHATLUNA_BRIDGE_PLATFORM_NAME,
      )
      this.warnedUnavailable = true
      return
    }

    const plugin = new runtime.ChatLunaPlugin(
      this.ctx,
      {},
      CHATLUNA_BRIDGE_PLATFORM_NAME,
      false,
    )
    const allStyles = this.aiGenerator.listStylePresets()
    registerChatLunaTools(
      plugin,
      runtime.StructuredTool,
      this.aiGenerator,
      this.getConfig,
      allStyles,
    )

    if (!chatlunaService.getPlugin?.(CHATLUNA_BRIDGE_PLATFORM_NAME)) {
      await Promise.resolve(chatlunaService.installPlugin(plugin))
    }

    this.chatLunaPlugin = plugin
    this.warnedUnavailable = false
    this.logger.info(
      'ChatLuna bridge enabled with %s base tools and %s style preset tools.',
      AI_GENERATOR_TOOL_DEFINITIONS.length,
      allStyles.length,
    )
  }

  private async disable() {
    this.contextInjectionDispose?.()
    this.contextInjectionDispose = undefined

    if (!this.chatLunaPlugin) return

    const plugin = this.chatLunaPlugin
    this.chatLunaPlugin = undefined

    const chatlunaService = this.getChatLunaService()
    try {
      chatlunaService?.uninstallPlugin(plugin)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn('failed to uninstall ChatLuna bridge plugin: %s', message)
    }

    try {
      await Promise.resolve(plugin.dispose?.())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn('failed to dispose ChatLuna bridge plugin: %s', message)
    }

    this.logger.info('ChatLuna bridge disabled.')
  }

  private getChatLunaService() {
    const service = (this.ctx as Context & {
      chatluna?: ChatLunaServiceLike
    }).chatluna

    if (!service) return null
    if (
      typeof service.installPlugin !== 'function' ||
      typeof service.uninstallPlugin !== 'function'
    ) {
      return null
    }

    return service
  }
}
