/**
 * ImageGenerationOrchestrator —— V2 MVP 简化版编排层。
 *
 * 与 v1 的差异：
 * - 当前阶段仅支持「文生图」与「图生图」两种核心流程。
 * - 移除 v1 中 `processComposeImageWithTimeout` / `processPresetImagesWithTimeout` 这类
 *   多分支 race 包装，改为单一线性 async/await + 顶层 Promise.race 处理超时。
 * - 不再依赖外部 `onRecordUserUsage` / `onGenerationFailure` 钩子；本编排器内部直接
 *   驱动 Service 的 `recordUsage` / 用户态封禁记录。
 * - Service 层 API 改名为 `aiImageGenerator`，所有调用通过 `AiImageGeneratorService`。
 */

import { h } from 'koishi'
import type { Context, Session } from 'koishi'

import type { Config } from '../shared/config.js'
import { COMMAND_TIMEOUT_SECONDS } from '../shared/constants.js'
import {
  formatPromptTimeoutError,
  getPromptTimeoutMs,
  getPromptTimeoutText,
} from '../shared/prompt-timeout.js'
import type {
  GenerationDisplayInfo,
  ImageRequestContext,
} from '../shared/types.js'
import type { AiImageGeneratorService } from '../service/AiImageGeneratorService.js'
import type { UserManager } from '../services/UserManager.js'
import {
  collectImagesFromParamAndQuote,
  parseMessageImagesAndText,
} from '../utils/input.js'

export interface ExecuteGenerationOptions {
  styleName: string
  finalPrompt: string
  imageUrls: string[]
  numImages: number
  requestContext?: ImageRequestContext
  displayInfo?: GenerationDisplayInfo
  /** 用于 rememberGeneratedImages 的可选样式标记（如 '文生图' 关联的预设名） */
  stylePreset?: string
}

export interface CreateImageGenerationHandlersParams {
  ctx: Context
  service: AiImageGeneratorService
  userManager: UserManager
  logger: ReturnType<Context['logger']>
  /** 始终返回最新 Config 引用（在热重载时由入口 acceptor 覆盖闭包） */
  getConfig: () => Config
}

export interface ImageGenerationHandlers {
  /** 文生图主流程：从 session/prompt 取输入，校验并触发生成。 */
  executeTextToImage(
    session: Session,
    initialPrompt: string | undefined,
    setupContext?: ImageRequestContext,
    displayInfo?: GenerationDisplayInfo,
  ): Promise<string>

  /** 图生图主流程：从 imgParam/quote/后续输入收集图片 + 描述，再触发生成。 */
  executeImageToImage(
    session: Session,
    imgParam: unknown,
    initialPrompt: string | undefined,
    setupContext?: ImageRequestContext,
    displayInfo?: GenerationDisplayInfo,
  ): Promise<string>

  /** 查询额度（额度命令的核心）。 */
  executeQueryQuota(session: Session): Promise<string>
}

const SECURITY_BLOCK_KEYWORDS = [
  '安全',
  '违规',
  'content_policy',
  'safety',
  'blocked',
  'safety_filter',
]

export function createImageGenerationHandlers(
  params: CreateImageGenerationHandlersParams,
): ImageGenerationHandlers {
  const { service, userManager, logger, getConfig } = params

  // ---------------------------------------------------------------------------
  // 内部工具
  // ---------------------------------------------------------------------------

  function isSecurityBlockError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '')
    const lower = message.toLowerCase()
    return SECURITY_BLOCK_KEYWORDS.some((kw) => lower.includes(kw))
  }

  function sanitizeForLog(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
      }
    }
    return { value: String(error ?? '') }
  }

  /** 收集文生图输入：优先取参数；否则发起 prompt 等待用户输入。 */
  async function collectTextInput(
    session: Session,
    initialPrompt: string | undefined,
  ): Promise<{ prompt: string } | { error: string }> {
    const config = getConfig()
    const trimmed = typeof initialPrompt === 'string' ? initialPrompt.trim() : ''
    if (trimmed) return { prompt: trimmed }

    await session.send('请输入画面描述')
    const msg = await session.prompt(getPromptTimeoutMs(config))
    if (!msg) return { error: formatPromptTimeoutError(config) }

    const parsed = parseMessageImagesAndText(msg)
    if (parsed.images.length > 0) {
      return { error: '检测到图片，文生图仅支持文字输入' }
    }
    if (!parsed.text) {
      return { error: '未检测到描述，操作已取消' }
    }
    return { prompt: parsed.text }
  }

  /** 收集图生图输入：先合并参数+引用图，必要时再 prompt 用户补充。 */
  async function collectImageInput(
    session: Session,
    imgParam: unknown,
    initialPrompt: string | undefined,
  ): Promise<{ images: string[]; prompt: string } | { error: string }> {
    const config = getConfig()
    const collected: string[] = collectImagesFromParamAndQuote(session, imgParam)
    let promptText = typeof initialPrompt === 'string' ? initialPrompt.trim() : ''

    // 已有图片：直接使用，prompt 可由命令参数补全
    if (collected.length > 0) {
      if (collected.length > 1) {
        return {
          error: '本功能仅支持处理一张图片，检测到多张图片',
        }
      }
      if (!promptText) {
        await session.send('请输入对图片的修改描述')
        const msg = await session.prompt(getPromptTimeoutMs(config))
        if (!msg) return { error: formatPromptTimeoutError(config) }
        const parsed = parseMessageImagesAndText(msg)
        if (!parsed.text) return { error: '未检测到描述，操作已取消' }
        promptText = parsed.text
      }
      return { images: collected, prompt: promptText }
    }

    // 没有图片：循环等待用户上传图片+描述
    await session.send(`请在${getPromptTimeoutText(config)}内发送一张图片`)
    while (true) {
      const msg = await session.prompt(getPromptTimeoutMs(config))
      if (!msg) return { error: formatPromptTimeoutError(config) }

      const parsed = parseMessageImagesAndText(msg)
      if (parsed.images.length > 0) {
        for (const img of parsed.images) {
          if (img.attrs?.src) collected.push(img.attrs.src as string)
        }
        if (collected.length > 1) {
          return { error: '本功能仅支持处理一张图片，检测到多张图片' }
        }
        if (parsed.text) promptText = parsed.text
        if (!promptText) {
          await session.send('请输入对图片的修改描述')
          const msg2 = await session.prompt(getPromptTimeoutMs(config))
          if (!msg2) return { error: formatPromptTimeoutError(config) }
          const parsed2 = parseMessageImagesAndText(msg2)
          if (!parsed2.text) return { error: '未检测到描述，操作已取消' }
          promptText = parsed2.text
        }
        return { images: collected, prompt: promptText }
      }

      if (parsed.text) {
        return { error: '未检测到图片，请重新发起指令并发送图片' }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 核心生成流程
  // ---------------------------------------------------------------------------

  async function runGeneration(
    session: Session,
    options: ExecuteGenerationOptions,
  ): Promise<string> {
    const config = getConfig()
    const userId = session.userId || 'unknown'
    const userName = session.username || session.author?.name || userId
    const platform = session.platform

    if (!userManager.startTask(userId)) {
      return '您当前已有正在处理的任务，请等待完成后再发起新请求'
    }

    const startedAt = Date.now()
    const timeoutMs = COMMAND_TIMEOUT_SECONDS * 1000

    // 顶层超时控制（命令级，与单次 HTTP 超时区分）
    let timeoutFired = false
    const checkTimeout = () => timeoutFired || Date.now() - startedAt > timeoutMs
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        timeoutFired = true
        reject(new Error(`命令执行超时（${COMMAND_TIMEOUT_SECONDS}秒）`))
      }, timeoutMs)
    })

    try {
      // 1. 配额预检
      const reservation = await service.checkAndReserveQuota(
        userId,
        userName,
        options.numImages,
        platform,
      )
      if (!reservation.allowed) {
        return reservation.message || '配额不足，无法继续生成'
      }

      // 2. 状态提示
      const statusParts: string[] = [`开始处理图片（${options.styleName}）`]
      if (options.displayInfo?.customAdditions?.length) {
        statusParts.push(`自定义内容：${options.displayInfo.customAdditions.join('；')}`)
      }
      if (options.displayInfo?.modelId) {
        const modelDesc = options.displayInfo.modelDescription || options.displayInfo.modelId
        statusParts.push(`使用模型：${modelDesc}`)
      }
      await session.send(statusParts.join('\n') + '...')

      // 3. 流式回调：每生成一张就发送
      const generatedImages: string[] = []
      let usageRecorded = false
      const onImageGenerated = async (
        imageUrl: string,
        index: number,
        total: number,
      ) => {
        if (checkTimeout()) {
          throw new Error('命令执行超时')
        }
        generatedImages.push(imageUrl)

        try {
          await session.send(h.image(imageUrl))
        } catch (sendError) {
          logger.error('发送图片失败', {
            userId,
            index: index + 1,
            total,
            ...sanitizeForLog(sendError),
          })
          throw sendError
        }

        // 第一张成功后立即记录用量，避免后续失败时漏扣
        if (!usageRecorded) {
          usageRecorded = true
          try {
            await service.recordUsage(
              userId,
              userName,
              options.styleName,
              total,
              platform,
            )
          } catch (recordError) {
            logger.error('记录用量失败', {
              userId,
              ...sanitizeForLog(recordError),
            })
          }
        }

        if (total > 1 && index < total - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }

      // 4. 实际调用 Provider（包在 race 中以兜住命令级超时）
      const generationPromise = service.requestProviderImages(
        options.finalPrompt,
        options.imageUrls,
        options.numImages,
        options.requestContext,
        onImageGenerated,
      )

      const allImages = await Promise.race([generationPromise, timeoutPromise])

      // 5. 兜底：流式回调没触发时，统一发送 + 记录用量
      if (!usageRecorded && allImages && allImages.length > 0) {
        for (const imageUrl of allImages) {
          if (!generatedImages.includes(imageUrl)) {
            try {
              await session.send(h.image(imageUrl))
              generatedImages.push(imageUrl)
            } catch (sendError) {
              logger.error('回退发送图片失败', {
                userId,
                ...sanitizeForLog(sendError),
              })
            }
          }
        }
        if (generatedImages.length > 0) {
          try {
            await service.recordUsage(
              userId,
              userName,
              options.styleName,
              generatedImages.length,
              platform,
            )
            usageRecorded = true
          } catch (recordError) {
            logger.error('记录用量失败（回退路径）', {
              userId,
              ...sanitizeForLog(recordError),
            })
          }
        }
      }

      // 6. 记忆生成结果
      if (generatedImages.length > 0) {
        try {
          service.rememberGeneratedImages({
            session,
            imageUrls: generatedImages,
            prompt: options.finalPrompt,
            source: 'generated',
            ...(options.requestContext !== undefined
              ? { requestContext: options.requestContext }
              : {}),
            ...(options.stylePreset !== undefined
              ? { stylePreset: options.stylePreset }
              : {}),
          })
        } catch (rememberError) {
          logger.error('保存图像记忆失败', {
            userId,
            ...sanitizeForLog(rememberError),
          })
        }

        // 可选：附带剩余配额提示
        if (config.showQuotaInImageCommands) {
          try {
            const summary = await service.getQuotaSummary(userId, userName)
            return `本次共发送 ${generatedImages.length} 张，剩余可用：今日免费 ${summary.remainingToday}，已购 ${summary.remainingPurchasedCount}`
          } catch {
            return ''
          }
        }
        return ''
      }

      return '生成失败：未返回任何图片，请稍后重试'
    } catch (error) {
      logger.error('图像生成流程异常', {
        userId,
        styleName: options.styleName,
        ...sanitizeForLog(error),
      })

      // 安全策略：内容审查相关错误记入 securityBlock
      if (isSecurityBlockError(error)) {
        try {
          const result = await userManager.recordSecurityBlock(userId, config)
          if (result.shouldWarn) {
            return '检测到内容安全相关错误，已记录。多次触发将影响后续使用，请调整描述后再试'
          }
        } catch (recordErr) {
          logger.error('记录安全阻断失败', {
            userId,
            ...sanitizeForLog(recordErr),
          })
        }
      }

      const message = error instanceof Error ? error.message : String(error)
      return `生成失败：${message}`
    } finally {
      userManager.endTask(userId)
    }
  }

  // ---------------------------------------------------------------------------
  // 对外 handlers
  // ---------------------------------------------------------------------------

  async function executeTextToImage(
    session: Session,
    initialPrompt: string | undefined,
    setupContext?: ImageRequestContext,
    displayInfo?: GenerationDisplayInfo,
  ): Promise<string> {
    const config = getConfig()
    const collected = await collectTextInput(session, initialPrompt)
    if ('error' in collected) return collected.error

    const numImages = setupContext?.numImages || config.defaultNumImages || 1
    return runGeneration(session, {
      styleName: '文生图',
      finalPrompt: collected.prompt,
      imageUrls: [],
      numImages,
      ...(setupContext !== undefined ? { requestContext: setupContext } : {}),
      ...(displayInfo !== undefined ? { displayInfo } : {}),
    })
  }

  async function executeImageToImage(
    session: Session,
    imgParam: unknown,
    initialPrompt: string | undefined,
    setupContext?: ImageRequestContext,
    displayInfo?: GenerationDisplayInfo,
  ): Promise<string> {
    const config = getConfig()
    const collected = await collectImageInput(session, imgParam, initialPrompt)
    if ('error' in collected) return collected.error

    const numImages = setupContext?.numImages || config.defaultNumImages || 1
    return runGeneration(session, {
      styleName: '图生图',
      finalPrompt: collected.prompt,
      imageUrls: collected.images,
      numImages,
      ...(setupContext !== undefined ? { requestContext: setupContext } : {}),
      ...(displayInfo !== undefined ? { displayInfo } : {}),
    })
  }

  async function executeQueryQuota(session: Session): Promise<string> {
    const userId = session.userId || 'unknown'
    const userName = session.username || session.author?.name || userId
    try {
      const summary = await service.getQuotaSummary(userId, userName)
      const lines: string[] = [
        `用户：${summary.userName}`,
        `今日免费剩余：${summary.remainingToday}`,
        `已购剩余：${summary.remainingPurchasedCount}`,
        `合计可用：${summary.totalAvailable}`,
        `历史总用量：${summary.totalUsageCount}`,
      ]
      if (summary.purchasedCount > 0) {
        lines.push(`累计已购：${summary.purchasedCount}`)
      }
      return lines.join('\n')
    } catch (error) {
      logger.error('查询额度失败', {
        userId,
        ...sanitizeForLog(error),
      })
      return '查询额度失败，请稍后重试'
    }
  }

  return {
    executeTextToImage,
    executeImageToImage,
    executeQueryQuota,
  }
}
