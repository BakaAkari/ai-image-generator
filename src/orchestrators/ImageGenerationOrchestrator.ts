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
import type { GenerationCost } from '../shared/billing.js'
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
  generationCost?: GenerationCost
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
    styleName?: string,
    stylePreset?: string,
  ): Promise<string>

  /** 图生图主流程：从 imgParam/quote/后续输入收集图片 + 描述，再触发生成。 */
  executeImageToImage(
    session: Session,
    imgParam: unknown,
    initialPrompt: string | undefined,
    setupContext?: ImageRequestContext,
    displayInfo?: GenerationDisplayInfo,
    styleName?: string,
    stylePreset?: string,
  ): Promise<string>

  /** 合成图主流程：收集多张图片，直到收到 prompt 文字后触发生成。 */
  executeComposeImage(
    session: Session,
    initialPrompt: string | undefined,
    setupContext?: ImageRequestContext,
    displayInfo?: GenerationDisplayInfo,
    styleName?: string,
    stylePreset?: string,
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

  async function sendFinalText(
    session: Session,
    message: string,
    userId: string,
    logLabel: string,
  ): Promise<string> {
    try {
      await session.send(message)
    } catch (sendError) {
      logger.error(logLabel, {
        userId,
        ...sanitizeForLog(sendError),
      })
    }
    return ''
  }

  /** 收集文生图输入：优先取参数；否则发起 prompt 等待用户输入。 */
  async function collectTextInput(
    session: Session,
    initialPrompt: string | undefined,
  ): Promise<{ prompt: string } | { error: string }> {
    const config = getConfig()
    const trimmed = typeof initialPrompt === 'string' ? initialPrompt.trim() : ''
    if (trimmed) return { prompt: trimmed }

    await session.send('请发送画面描述')
    const msg = await session.prompt(getPromptTimeoutMs(config))
    if (!msg) return { error: formatPromptTimeoutError(config) }

    const parsed = parseMessageImagesAndText(msg)
    if (parsed.images.length > 0) {
      return { error: '输入不匹配｜文生图仅支持文字描述' }
    }
    if (!parsed.text) {
      return { error: '已取消｜未检测到描述' }
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
          error: '输入不匹配｜图生图仅支持 1 张图片',
        }
      }
      if (!promptText) {
        await session.send('请发送图片修改描述')
        const msg = await session.prompt(getPromptTimeoutMs(config))
        if (!msg) return { error: formatPromptTimeoutError(config) }
        const parsed = parseMessageImagesAndText(msg)
        if (!parsed.text) return { error: '已取消｜未检测到描述' }
        promptText = parsed.text
      }
      return { images: collected, prompt: promptText }
    }

    // 没有图片：循环等待用户上传图片+描述
    await session.send(`请在 ${getPromptTimeoutText(config)}内发送 1 张图片`)
    while (true) {
      const msg = await session.prompt(getPromptTimeoutMs(config))
      if (!msg) return { error: formatPromptTimeoutError(config) }

      const parsed = parseMessageImagesAndText(msg)
      if (parsed.images.length > 0) {
        for (const img of parsed.images) {
          if (img.attrs?.src) collected.push(img.attrs.src as string)
        }
        if (collected.length > 1) {
          return { error: '输入不匹配｜图生图仅支持 1 张图片' }
        }
        if (parsed.text) promptText = parsed.text
        if (!promptText) {
          await session.send('请发送图片修改描述')
          const msg2 = await session.prompt(getPromptTimeoutMs(config))
          if (!msg2) return { error: formatPromptTimeoutError(config) }
          const parsed2 = parseMessageImagesAndText(msg2)
          if (!parsed2.text) return { error: '已取消｜未检测到描述' }
          promptText = parsed2.text
        }
        return { images: collected, prompt: promptText }
      }

      if (parsed.text) {
        return { error: '输入不匹配｜未检测到图片，请重新发起指令' }
      }
    }
  }

  /** 收集合成图输入：累计多张图片，直到收到 prompt 文字后执行。 */
  async function collectComposeInput(
    session: Session,
    initialPrompt: string | undefined,
  ): Promise<{ images: string[]; prompt: string } | { error: string }> {
    const config = getConfig()
    const collected: string[] = []
    const initialPromptText = typeof initialPrompt === 'string' ? initialPrompt.trim() : ''

    await session.send(`请在 ${getPromptTimeoutText(config)}内发送至少 2 张图片；发送合成描述后开始`)

    while (true) {
      const msg = await session.prompt(getPromptTimeoutMs(config))
      if (!msg) return { error: formatPromptTimeoutError(config) }

      const parsed = parseMessageImagesAndText(msg)
      for (const img of parsed.images) {
        if (img.attrs?.src && collected.length < 8) {
          collected.push(img.attrs.src as string)
        }
      }

      const promptText = parsed.text || initialPromptText
      if (promptText) {
        if (collected.length < 2) {
          return { error: `图片不足｜至少需要 2 张，当前 ${collected.length} 张` }
        }
        return { images: collected, prompt: promptText }
      }

      if (collected.length >= 8) {
        await session.send('已收到 8 张；已达上限，请发送合成描述')
        continue
      }

      if (parsed.images.length > 0) {
        await session.send(`已收到 ${collected.length} 张；继续发图或发送合成描述`)
        continue
      }

      return { error: '已取消｜未检测到图片或描述' }
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

    const taskTtlMs = Math.max(COMMAND_TIMEOUT_SECONDS * 1000 + 60_000, (config.apiTimeout || 60) * 1000 * 4)
    const requestId = userManager.startTask(userId, taskTtlMs)
    if (!requestId) {
      return '任务进行中，请完成后再试'
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
      const estimatedCost = options.generationCost || service.calculateGenerationCost(options.numImages, options.requestContext)

      // 1. 积分预检
      const reservation = await service.checkAndReserveQuota(
        userId,
        userName,
        estimatedCost,
        platform,
      )
      if (!reservation.allowed) {
        return reservation.message || '额度不足｜无法继续生成'
      }

      // 2. 状态提示
      const statusParts: string[] = []
      if (options.displayInfo?.customAdditions?.length) {
        statusParts.push(`- 追加｜${options.displayInfo.customAdditions.join('；')}`)
      }
      if (options.displayInfo?.modelId) {
        const modelDesc = options.displayInfo.modelDescription || options.displayInfo.modelId
        statusParts.push(`- 模型｜${modelDesc}`)
      }
      if (config.showCreditCostInResult) {
        statusParts.push(`- 预计消耗｜${service.formatCredits(estimatedCost.totalCredits)}`)
      }
      await session.send(statusParts.length
        ? ['开始生成', '', `- 类型｜${options.styleName}`, ...statusParts].join('\n')
        : `开始生成｜${options.styleName}`)

      // 3. 流式回调：每生成一张就发送
      const generatedImages: string[] = []
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

      // 5. 兜底：流式回调没触发时，统一发送
      if (allImages && allImages.length > 0) {
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
      }

      // 6. 成功发送后按实际图片数扣费并记录用量
      let usageResult: Awaited<ReturnType<AiImageGeneratorService['recordUsage']>> | undefined
      if (generatedImages.length > 0) {
        const actualCost = service.scaleGenerationCost(estimatedCost, generatedImages.length)
        try {
          usageResult = await service.recordUsage(
            userId,
            userName,
            options.styleName,
            actualCost,
            platform,
            requestId,
          )
        } catch (recordError) {
          logger.error('记录用量失败', {
            userId,
            ...sanitizeForLog(recordError),
          })
          return sendFinalText(
            session,
            ['生成已完成但扣费记录失败', '', '- 建议｜联系管理员核对账单'].join('\n'),
            userId,
            '发送扣费失败提示失败',
          )
        }
      }

      // 7. 记忆生成结果
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

        // 可选：附带积分提示
        if (config.showQuotaInImageCommands || config.showCreditCostInResult) {
          try {
            const summary = usageResult?.summary || await service.getQuotaSummary(userId, userName)
            const lines = [
              '生成完成',
              '',
              `- 图片｜${generatedImages.length} 张`,
            ]
            if (config.showCreditCostInResult) {
              lines.push(`- 本次消耗｜${service.formatCredits(usageResult?.consumedCredits ?? 0)}`)
            }
            if (config.showQuotaInImageCommands) {
              lines.push(
                `- 今日免费｜${service.formatCredits(summary.dailyFreeRemaining)}`,
                `- 已购余额｜${service.formatCredits(summary.purchasedCredits)}`,
                `- 合计可用｜${service.formatCredits(summary.totalAvailable)}`,
              )
            }
            return lines.join('\n')
          } catch {
            return ''
          }
        }
        return ''
      }

      return sendFinalText(
        session,
        ['生成失败', '', '- 原因｜未返回图片', '- 建议｜稍后重试或调整描述'].join('\n'),
        userId,
        '发送生成失败提示失败',
      )
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
            return sendFinalText(
              session,
              ['内容安全拦截', '', '请调整描述后再试；多次触发会影响后续使用'].join('\n'),
              userId,
              '发送内容安全拦截提示失败',
            )
          }
        } catch (recordErr) {
          logger.error('记录安全阻断失败', {
            userId,
            ...sanitizeForLog(recordErr),
          })
        }
      }

      const message = error instanceof Error ? error.message : String(error)
      return sendFinalText(
        session,
        ['生成失败', '', `- 原因｜${message}`].join('\n'),
        userId,
        '发送生成失败提示失败',
      )
    } finally {
      userManager.endTask(userId, requestId)
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
    styleName = '文生图',
    stylePreset?: string,
  ): Promise<string> {
    const config = getConfig()
    const collected = await collectTextInput(session, initialPrompt)
    if ('error' in collected) return collected.error

    const numImages = setupContext?.numImages || config.defaultNumImages || 1
    return runGeneration(session, {
      styleName,
      finalPrompt: collected.prompt,
      imageUrls: [],
      numImages,
      ...(setupContext !== undefined ? { requestContext: setupContext } : {}),
      ...(displayInfo !== undefined ? { displayInfo } : {}),
      generationCost: setupContext ? service.calculateGenerationCost(numImages, setupContext) : undefined,
      ...(stylePreset !== undefined ? { stylePreset } : {}),
    })
  }

  async function executeImageToImage(
    session: Session,
    imgParam: unknown,
    initialPrompt: string | undefined,
    setupContext?: ImageRequestContext,
    displayInfo?: GenerationDisplayInfo,
    styleName = '图生图',
    stylePreset?: string,
  ): Promise<string> {
    const config = getConfig()
    const collected = await collectImageInput(session, imgParam, initialPrompt)
    if ('error' in collected) return collected.error

    const numImages = setupContext?.numImages || config.defaultNumImages || 1
    return runGeneration(session, {
      styleName,
      finalPrompt: collected.prompt,
      imageUrls: collected.images,
      numImages,
      ...(setupContext !== undefined ? { requestContext: setupContext } : {}),
      ...(displayInfo !== undefined ? { displayInfo } : {}),
      generationCost: setupContext ? service.calculateGenerationCost(numImages, setupContext) : undefined,
      ...(stylePreset !== undefined ? { stylePreset } : {}),
    })
  }

  async function executeComposeImage(
    session: Session,
    initialPrompt: string | undefined,
    setupContext?: ImageRequestContext,
    displayInfo?: GenerationDisplayInfo,
    styleName = '合成图',
    stylePreset?: string,
  ): Promise<string> {
    const config = getConfig()
    const collected = await collectComposeInput(session, initialPrompt)
    if ('error' in collected) return collected.error

    const numImages = setupContext?.numImages || config.defaultNumImages || 1
    return runGeneration(session, {
      styleName,
      finalPrompt: collected.prompt,
      imageUrls: collected.images,
      numImages,
      ...(setupContext !== undefined ? { requestContext: setupContext } : {}),
      ...(displayInfo !== undefined ? { displayInfo } : {}),
      generationCost: setupContext ? service.calculateGenerationCost(numImages, setupContext) : undefined,
      ...(stylePreset !== undefined ? { stylePreset } : {}),
    })
  }

  async function executeQueryQuota(session: Session): Promise<string> {
    const userId = session.userId || 'unknown'
    const userName = session.username || session.author?.name || userId
    try {
      const summary = await service.getQuotaSummary(userId, userName)
      const lines: string[] = [
        '图像额度',
        '',
        `- 用户｜${summary.userName}`,
        `- 今日免费｜${service.formatCredits(summary.dailyFreeRemaining)}`,
        `- 已购余额｜${service.formatCredits(summary.purchasedCredits)}`,
        `- 合计可用｜${service.formatCredits(summary.totalAvailable)}`,
        `- 已生成｜${summary.totalImagesGenerated} 张`,
        `- 历史消耗｜${service.formatCredits(summary.totalConsumedCredits)}`,
      ]
      if (summary.estimatedCny !== undefined) {
        lines.push(`- 余额估算｜约 ${summary.estimatedCny} 元`)
      }
      return lines.join('\n')
    } catch (error) {
      logger.error('查询额度失败', {
        userId,
        ...sanitizeForLog(error),
      })
      return ['查询失败', '', '- 类型｜图像额度', '- 建议｜稍后重试'].join('\n')
    }
  }

  return {
    executeTextToImage,
    executeImageToImage,
    executeComposeImage,
    executeQueryQuota,
  }
}
