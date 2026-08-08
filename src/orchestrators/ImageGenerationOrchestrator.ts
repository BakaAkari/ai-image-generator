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
import { sanitizeString } from '../providers/utils.js'

import type { Config } from '../shared/config.js'
import { COMMAND_TIMEOUT_SECONDS } from '../shared/constants.js'
import {
  formatPromptTimeoutError,
  getPromptTimeoutMs,
  getPromptTimeoutText,
} from '../shared/prompt-timeout.js'
import type { GenerationCost } from '../shared/billing.js'
import { computeActualSupplierCredits, computePostGenerationCost, computeUpperBoundSupplierCredits, resolveMappingFixedCost, roundCredits } from '../shared/billing.js'
import type { CatalogModelForPricing } from '../shared/billing.js'
import type {
  GenerationDisplayInfo,
  ImageRequestContext,
  ModelMappingConfig,
} from '../shared/types.js'
import { queryLogQuotaByRequestId } from '../services/log-quota.js'
import { applyPromptAppends } from '../shared/generation-setup.js'
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

export interface ExecuteImageToImageOptions {
  /**
   * 是否从 session.quote（引用消息）收集图片，默认 true。
   * 向导确认路径传 false：图片已由向导显式收集，
   * 防止「确认」消息引用的无关图片混入或盖过向导图片。
   */
  includeQuote?: boolean
}

export interface ExecuteComposeImageOptions {
  /** 同 includeQuote 语义，默认 true；向导确认路径传 false */
  includeQuote?: boolean
  /** 已预收集的图片（向导路径）；与命令消息/引用图片合并后去重截断 */
  initialImages?: string[]
}

/** 计价所需的目录快照访问器（不含完整 ImageCatalogService 依赖）。 */
interface CatalogAccessor {
  current: { models: CatalogModelForPricing[]; groupRatio?: Record<string, number> } | null
  billingInfo: { supplierCredits?: number | null } | null
}

export interface CreateImageGenerationHandlersParams {
  ctx: Context
  service: AiImageGeneratorService
  userManager: UserManager
  logger: ReturnType<Context['logger']>
  /** 始终返回最新 Config 引用（在热重载时由入口 acceptor 覆盖闭包） */
  getConfig: () => Config
  /** 目录快照访问器（用于定价读取 & 计费 delta 日志） */
  catalog: CatalogAccessor
  /**
   * 日志真源结算凭据获取器（可选）：返回 { apiBase, apiKey, userId }，MJ 等
   * 逐任务精确计费模型在生成成功后按 request_id 查 /api/log/self 拿权威 quota。
   * 返回 null 表示未配置，结算走公式链。
   */
  getLogAccessCredentials?: () => { apiBase: string; apiKey: string; userId: number; extraHeaders?: Record<string, string>; timeoutSec?: number } | null
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
    options?: ExecuteImageToImageOptions,
  ): Promise<string>

  /** 合成图主流程：收集多张图片，直到收到 prompt 文字后触发生成。 */
  executeComposeImage(
    session: Session,
    initialPrompt: string | undefined,
    setupContext?: ImageRequestContext,
    displayInfo?: GenerationDisplayInfo,
    styleName?: string,
    stylePreset?: string,
    options?: ExecuteComposeImageOptions,
  ): Promise<string>

}

const SECURITY_BLOCK_KEYWORDS = [
  '安全',
  '违规',
  'content_policy',
  'safety',
  'blocked',
  'safety_filter',
]

// ---------------------------------------------------------------------------
// 等待用户输入（Bug 5 修复）
// ---------------------------------------------------------------------------

/** 等待用户下一条输入的结果类别 */
type WaitInputResult =
  | { kind: 'message'; content: string }
  /** 检测到新指令：消息已放行给指令系统，本次收集应静默结束 */
  | { kind: 'interrupted' }
  /** 用户回复「取消」，消息已吞掉 */
  | { kind: 'cancelled' }
  | { kind: 'timeout' }

const CANCEL_WORDS = new Set(['取消', 'cancel'])

/**
 * 判断消息是否为可解析的指令调用（任意插件注册的指令，含别名）。
 * 用 stripped.content（已剥离 at 与前缀）的首个 token 查 commander。
 */
function isCommandInvocation(session: Session, text: string): boolean {
  const stripped = session.stripped?.content?.trim() || text.trim()
  const firstToken = stripped.split(/\s+/)[0]
  if (!firstToken) return false
  const commander = (session.app as unknown as {
    $commander?: { get(name: string, session?: Session): unknown }
  }).$commander
  if (!commander?.get) return false
  try {
    return Boolean(commander.get(firstToken, session))
  } catch {
    return false
  }
}

/**
 * 等待用户输入，替代裸 session.prompt：
 * - 新指令 → callback 返回 null，Koishi prompt 内部会 next() 放行，指令正常执行（不被等待吞掉）
 * - 「取消」→ 吞掉消息，返回 cancelled
 * - 其它消息 → 返回原始 content
 *
 * 注意：prompt 的会话级中间件会在任一匹配消息到达时自销毁，因此放行指令后
 * 本等待一定结束，不会残留监听器。
 */
async function waitUserInput(session: Session, timeoutMs: number): Promise<WaitInputResult> {
  const result = await session.prompt<WaitInputResult | null | undefined>((incoming) => {
    const content = incoming.content ?? ''
    const text = parseMessageImagesAndText(content).text
    if (text && isCommandInvocation(incoming, text)) return null
    if (text && CANCEL_WORDS.has(text.trim().toLowerCase())) return { kind: 'cancelled' }
    return { kind: 'message', content }
  }, { timeout: timeoutMs })
  if (result === null) return { kind: 'interrupted' }
  if (result === undefined) return { kind: 'timeout' }
  return result
}

export function createImageGenerationHandlers(
  params: CreateImageGenerationHandlersParams,
): ImageGenerationHandlers {
  const { service, userManager, logger, getConfig, catalog, getLogAccessCredentials } = params

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
        message: sanitizeString(error.message),
      }
    }
    return { value: sanitizeString(String(error ?? '')) }
  }

  function isGroupSession(session: Session): boolean {
    return (session as Session & { isDirect?: boolean }).isDirect !== true && Boolean(session.guildId)
  }

  function formatUserScopedText(session: Session, message: string, userId: string, userName?: string): string {
    if (!isGroupSession(session) || !userId || userId === 'unknown') return message
    const displayName = sanitizeString((userName || userId).trim()) || userId
    const [firstLine = '', ...restLines] = message.split('\n')
    const scopedFirstLine = `[${displayName}] ${firstLine}`.trimEnd()
    return [scopedFirstLine, ...restLines].join('\n')
  }

  async function sendFinalText(
    session: Session,
    message: string,
    userId: string,
    logLabel: string,
    userName?: string,
  ): Promise<string> {
    try {
      await session.send(formatUserScopedText(session, message, userId, userName))
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

    await session.send('请发送画面描述；回复「取消」中止')
    const wait = await waitUserInput(session, getPromptTimeoutMs(config))
    if (wait.kind === 'interrupted') return { error: '' }
    if (wait.kind === 'cancelled') return { error: '已取消' }
    if (wait.kind === 'timeout') return { error: formatPromptTimeoutError(config) }

    const parsed = parseMessageImagesAndText(wait.content)
    if (parsed.images.length > 0) {
      return { error: '输入不匹配｜文生图仅支持文字描述' }
    }
    if (!parsed.text) {
      return { error: '已取消｜未检测到描述' }
    }
    return { prompt: parsed.text }
  }

  /** 收集图生图输入：先合并参数+引用图，必要时再等待用户补充。 */
  async function collectImageInput(
    session: Session,
    imgParam: unknown,
    initialPrompt: string | undefined,
    options?: { includeQuote?: boolean },
  ): Promise<{ images: string[]; prompt: string } | { error: string }> {
    const config = getConfig()
    const collected: string[] = collectImagesFromParamAndQuote(session, imgParam, options?.includeQuote !== false)
    let promptText = typeof initialPrompt === 'string' ? initialPrompt.trim() : ''

    // 已有图片：直接使用，prompt 可由命令参数补全
    if (collected.length > 0) {
      if (collected.length > 1) {
        return {
          error: '输入不匹配｜图生图仅支持 1 张图片',
        }
      }
      if (!promptText) {
        await session.send('请发送图片修改描述；回复「取消」中止')
        const wait = await waitUserInput(session, getPromptTimeoutMs(config))
        if (wait.kind === 'interrupted') return { error: '' }
        if (wait.kind === 'cancelled') return { error: '已取消' }
        if (wait.kind === 'timeout') return { error: formatPromptTimeoutError(config) }
        const parsed = parseMessageImagesAndText(wait.content)
        if (!parsed.text) return { error: '已取消｜未检测到描述' }
        promptText = parsed.text
      }
      return { images: collected, prompt: promptText }
    }

    // 没有图片：循环等待用户上传图片+描述
    await session.send(`请在 ${getPromptTimeoutText(config)}内发送 1 张图片；回复「取消」中止`)
    while (true) {
      const wait = await waitUserInput(session, getPromptTimeoutMs(config))
      if (wait.kind === 'interrupted') return { error: '' }
      if (wait.kind === 'cancelled') return { error: '已取消' }
      if (wait.kind === 'timeout') return { error: formatPromptTimeoutError(config) }

      const parsed = parseMessageImagesAndText(wait.content)
      if (parsed.images.length > 0) {
        for (const img of parsed.images) {
          if (img.attrs?.src) collected.push(img.attrs.src as string)
        }
        if (collected.length > 1) {
          return { error: '输入不匹配｜图生图仅支持 1 张图片' }
        }
        if (parsed.text) promptText = parsed.text
        if (!promptText) {
          await session.send('请发送图片修改描述；回复「取消」中止')
          const wait2 = await waitUserInput(session, getPromptTimeoutMs(config))
          if (wait2.kind === 'interrupted') return { error: '' }
          if (wait2.kind === 'cancelled') return { error: '已取消' }
          if (wait2.kind === 'timeout') return { error: formatPromptTimeoutError(config) }
          const parsed2 = parseMessageImagesAndText(wait2.content)
          if (!parsed2.text) return { error: '已取消｜未检测到描述' }
          promptText = parsed2.text
        }
        return { images: collected, prompt: promptText }
      }

      if (parsed.text) {
        return { error: '输入不匹配｜未检测到图片，请重新发起指令' }
      }

      // 既无图又无文字（贴纸/表情/语音等）：给出反馈后继续等待，不再静默空转（Bug 7）
      await session.send(`未检测到图片，还需 1 张图片；回复「取消」中止`)
    }
  }

  /** 收集合成图输入：先收集同条消息/引用/预收集图片，再按进度等待补充，直到收到描述后执行。 */
  async function collectComposeInput(
    session: Session,
    initialPrompt: string | undefined,
    options?: ExecuteComposeImageOptions,
  ): Promise<{ images: string[]; prompt: string } | { error: string }> {
    const config = getConfig()
    const collected: string[] = []
    const initialPromptText = typeof initialPrompt === 'string' ? initialPrompt.trim() : ''

    // Bug 6：同条命令消息与引用消息中的图片不再被忽略；向导预收集图片合并进来
    const pushImages = (srcs: (string | undefined)[]) => {
      for (const src of srcs) {
        if (src && !collected.includes(src) && collected.length < 8) collected.push(src)
      }
    }
    pushImages(options?.initialImages ?? [])
    pushImages(parseMessageImagesAndText(session.content ?? '').images.map(i => i.attrs?.src))
    if (options?.includeQuote !== false && session.quote?.elements) {
      pushImages(h.select(session.quote.elements, 'img').map(i => i.attrs?.src))
    }

    // 已有 ≥2 图且有描述 → 直接生成，无需等待
    if (collected.length >= 2 && initialPromptText) {
      return { images: collected, prompt: initialPromptText }
    }

    // 按当前进度给出提示
    if (collected.length > 0) {
      await session.send(`已收到 ${collected.length} 张，合成至少需要 2 张；继续发图或发送合成描述；回复「取消」中止`)
    } else {
      await session.send(`请在 ${getPromptTimeoutText(config)}内发送至少 2 张图片；发送合成描述后开始；回复「取消」中止`)
    }

    while (true) {
      const wait = await waitUserInput(session, getPromptTimeoutMs(config))
      if (wait.kind === 'interrupted') return { error: '' }
      if (wait.kind === 'cancelled') return { error: '已取消' }
      if (wait.kind === 'timeout') return { error: formatPromptTimeoutError(config) }

      const parsed = parseMessageImagesAndText(wait.content)
      pushImages(parsed.images.map(i => i.attrs?.src))

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
    const userId = session.userId
    if (!userId) {
      return formatUserScopedText(session, '无法识别用户身份，请稍后重试', '', userId || '')
    }
    const userName = session.username || session.author?.name || userId
    const platform = session.platform

    // 限流检查：所有路径（命令 / 向导 / 免计费平台）统一在此拦截，避免各调用点漏加
    const rateLimit = userManager.checkRateLimit(userId, config)
    if (!rateLimit.allowed) {
      return formatUserScopedText(session, rateLimit.message || '操作过于频繁，请稍后再试', userId, userName)
    }

    const freePlatform = service.isFreePlatform(platform)

    // 任务锁 TTL 上限为命令超时 + 2 分钟兜底，避免长时间卡锁
    const graceMs = 120_000
    const taskTtlMs = Math.min(
      COMMAND_TIMEOUT_SECONDS * 1000 + graceMs,
      Math.max(COMMAND_TIMEOUT_SECONDS * 1000 + 60_000, (config.apiTimeout || 60) * 1000 * 4),
    )
    const requestId = userManager.startTask(userId, taskTtlMs)
    if (!requestId) {
      return formatUserScopedText(session, '任务进行中，请完成后再试', userId, userName)
    }

    const startedAt = Date.now()
    const timeoutMs = COMMAND_TIMEOUT_SECONDS * 1000

    // 顶层超时控制（命令级，与单次 HTTP 超时区分）。
    // Promise.race 不能取消底层 Provider Promise，因此必须让后续回调显式失效，
    // 防止旧请求在命令超时后继续向会话发送图片。
    let generationActive = true
    let timeoutFired = false
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    const checkTimeout = () => timeoutFired || Date.now() - startedAt > timeoutMs
    const isGenerationStale = () => !generationActive || checkTimeout()
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        timeoutFired = true
        generationActive = false
        reject(new Error(`命令执行超时（${COMMAND_TIMEOUT_SECONDS}秒）`))
      }, timeoutMs)
    })

    try {
      // ── 目录快照（生成前锁定，确保预估价和结算价使用同一份目录数据） ──
      const catalogModels = catalog.current?.models ?? []
      if (!catalogModels.length) {
        return formatUserScopedText(session, '模型目录尚未就绪，请稍后重试', userId, userName)
      }
      const modelIdForPricing = options.requestContext?.modelId ?? options.displayInfo?.modelId ?? ''
      const requestedSuffix = options.requestContext?.modelSuffix
      const mapping = config.modelMappings?.find(m => requestedSuffix ? m.suffix === requestedSuffix : m.modelId === modelIdForPricing)
      // 动态倍率优先级：mapping.ratioOverride > MJ 协议默认因子 > enable_groups 表上界 > 1
      const groupRatioMap = catalog.current?.groupRatio
      const ratioOverride = resolveEffectiveRatioOverride(modelIdForPricing, mapping, catalogModels)
      const numImages = options.numImages || 1
      // 预扣基准：公式上界（enable_groups 表最高倍率 × pricePerCall 或 per-token 上界）。
      // 结算路径在生成完成后按真实 usage / 日志真源精确结算，多退少补。
      // simple 模式（映射级固定积分 creditCostPerImage）：跳过公式链，直接按固定积分预扣。
      const mappingFixedCost = resolveMappingFixedCost(mapping, config.configMode)
      const formulaBase = mappingFixedCost != null
        ? { totalCredits: mappingFixedCost, creditCostPerImage: mappingFixedCost, numImages: 1, modelId: modelIdForPricing, costSource: 'model-fixed' as const }
        : (modelIdForPricing
          ? estimatePreGenerationCostWithDynamicUpper(modelIdForPricing, config, catalogModels, groupRatioMap, ratioOverride)
          : (options.generationCost || service.calculateGenerationCost(options.numImages, options.requestContext)))
      const estimatedCost: GenerationCost | undefined = freePlatform
        ? undefined
        : (modelIdForPricing
          ? {
              ...formulaBase,
              totalCredits: roundCredits(formulaBase.totalCredits * numImages),
              creditCostPerImage: roundCredits(formulaBase.totalCredits),
              numImages,
            }
          : formulaBase)

      // 1. 积分预检（免计费平台完全跳过预授权）
      if (!freePlatform) {
        const reservation = await service.reserveCredits(userId, userName, requestId, estimatedCost!, platform, mapping?.modelId === config.freeTrialModelId)
        if (!reservation.allowed) {
          return formatUserScopedText(session, reservation.message || '额度不足｜无法继续生成', userId, userName)
        }
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
      if (!freePlatform && config.showCreditCostInResult && estimatedCost) {
        statusParts.push(`- 预计消耗｜${service.formatCredits(estimatedCost.totalCredits)}`)
      }
      const startMessage = statusParts.length
        ? ['开始生成', '', `- 类型｜${options.styleName}`, ...statusParts].join('\n')
        : `开始生成｜${options.styleName}`
      await session.send(formatUserScopedText(session, startMessage, userId, userName))

      // 计费 delta 日志：生成前快照
      const preCredits = catalog.billingInfo?.supplierCredits ?? null

      // 3. 流式回调：每生成一张就发送
      const generatedImages: string[] = []
      const onImageGenerated = async (
        imageUrl: string,
        index: number,
        total: number,
      ) => {
        if (isGenerationStale()) {
          logger.warn('忽略已失效的图像生成回调', {
            userId,
            requestId,
            index: index + 1,
            total,
            timeoutFired,
          })
          return
        }
        try {
          if (isGenerationStale()) {
            logger.warn('跳过已失效的图片发送', {
              userId,
              requestId,
              index: index + 1,
              total,
              timeoutFired,
            })
            return
          }
          await session.send(h.image(imageUrl))
          generatedImages.push(imageUrl)
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
      // 协议参数补全阶段可能生成 promptAppends（如 MJ --ar / --stylize），
      // 由 shared/generation-setup 统一去重，在此拼接到最终 prompt 尾部。
      const providerPrompt = applyPromptAppends(options.finalPrompt, options.requestContext?.promptAppends)
      const generationPromise = service.requestProviderImages(
        providerPrompt,
        options.imageUrls,
        options.numImages,
        options.requestContext,
        onImageGenerated,
      )

      const allImages = await Promise.race([generationPromise, timeoutPromise])
      generationActive = false
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer)
        timeoutTimer = undefined
      }

      // 5. 兜底：流式回调没触发时，统一发送
      if (allImages && allImages.length > 0 && !checkTimeout()) {
        for (const imageUrl of allImages) {
          if (!generatedImages.includes(imageUrl)) {
            try {
              if (checkTimeout()) break
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

      // 6. 成功发送后按模型定价规则计算实际成本并扣费（免计费平台仅记录统计增量）
      let usageResult: Awaited<ReturnType<AiImageGeneratorService['settleReservation']>> | undefined
      if (generatedImages.length > 0 && freePlatform) {
        try {
          const freeModelId = options.requestContext?.modelId || options.displayInfo?.modelId
          await service.recordUsageOnly(userId, userName, options.styleName, generatedImages.length, freeModelId)
        } catch (recordError) {
          logger.error('免计费平台记录用量失败', {
            userId,
            ...sanitizeForLog(recordError),
          })
        }
      }
      if (generatedImages.length > 0 && !freePlatform) {
        try {
          const modelId = options.requestContext?.modelId ?? ''
          // TODO: accumulate tokens across multi-call batches
          const totalTokens = service.lastProviderUsage
          const inputTokens = service.lastProviderInputTokens
          const outputTokens = service.lastProviderOutputTokens

          // 从目录快照读取计价参数计算供应商积分（不使用 mapping 字段）
          const settleSuffix = options.requestContext?.modelSuffix
          const settleMapping = config.modelMappings?.find(m => settleSuffix ? m.suffix === settleSuffix : m.modelId === modelId)
          // 动态倍率结算：header 命中表 > ratioOverride > table.default > 1
          const routingGroup = service.lastProviderRoutingGroup
          const groupRatioMap = catalog.current?.groupRatio
          const settleOverride = resolveEffectiveRatioOverride(modelId, settleMapping, catalogModels)
          const actualRatio = resolveActualRoutingRatio(routingGroup, groupRatioMap, settleOverride)
          // 结算优先级：MJ 日志真源（若配置 logAccess 且捕获 request_id）→ 公式链
          //   - 日志真源：quota / quotaPerUnit(默认 500000) = 权威美元；不重复叠加 routingGroup。
          //   - 公式链：per-call = pricePerCall × actualRatio；per-token = eff_tokens × tokenRatio × actualRatio / quotaPerUnit。
          const providerRequestId = service.lastProviderRequestId
          const logCreds = getLogAccessCredentials?.()
          let logSourceQuota: number | null = null
          if (logCreds && providerRequestId) {
            try {
              const looked = await queryLogQuotaByRequestId(logCreds, providerRequestId)
              if (looked && Number.isFinite(looked.quota) && looked.quota >= 0) {
                logSourceQuota = looked.quota
              }
            } catch (err) {
              logger.warn('log-quota lookup failed model=%s requestId=%s: %s', modelId, providerRequestId, sanitizeString(err instanceof Error ? err.message : String(err)))
            }
          }
          const settleSource: 'log' | 'formula' | 'fixed' = logSourceQuota != null ? 'log' : 'formula'
          const quotaPerUnit = typeof config.quotaPerUnit === 'number' && Number.isFinite(config.quotaPerUnit) && config.quotaPerUnit > 0
            ? config.quotaPerUnit
            : 500000
          // simple 模式（映射级固定积分 creditCostPerImage）：结算直接按固定积分，不走公式链 / 日志真源。
          const settleFixedCost = resolveMappingFixedCost(settleMapping, config.configMode)
          const supplierCredits = settleFixedCost != null
            ? settleFixedCost
            : (logSourceQuota != null
              ? logSourceQuota / quotaPerUnit
              : computeActualSupplierCredits(modelId, totalTokens, catalogModels, actualRatio, inputTokens, outputTokens, config.quotaPerUnit))
          const settleKind = settleFixedCost != null ? 'fixed' : settleSource
          // 结算使用精确 4dp 精度，避免 per-token 模型微额消耗被 2 位取整吞没
          const actualCost = settleFixedCost != null
            ? settleFixedCost
            : computePostGenerationCost(supplierCredits, config, { round: false })

          // audit trail：完整记录定价计算过程，事后可追溯（含路由分组、覆盖、倍率、日志真源）
          const postCredits = catalog.billingInfo?.supplierCredits ?? null
          logger.info(
            'settlement-audit model=%s pricingType=%s totalTokens=%s inputTokens=%s outputTokens=%s routingGroup=%s ratioOverride=%s actualRatio=%s source=%s requestId=%s logQuota=%s supplierCredits=%s creditsPerCny=%s markup=%s actualCost=%s delivered=%d billingPre=%s billingPost=%s delta=%s',
            modelId,
            catalogModels.find(m => m.id === modelId)?.pricing?.type ?? 'unknown',
            totalTokens,
            inputTokens ?? '-',
            outputTokens ?? '-',
            routingGroup ?? '-',
            settleOverride ?? '-',
            actualRatio,
            settleSource,
            providerRequestId ?? '-',
            logSourceQuota ?? '-',
            supplierCredits,
            config.creditsPerCny,
            config.pricingMarkupPercent,
            actualCost,
            generatedImages.length,
            preCredits,
            postCredits,
            preCredits != null && postCredits != null ? postCredits - preCredits : 'n/a',
          )

          usageResult = await service.settleReservation(
            requestId,
            generatedImages.length,
            options.styleName,
            { routeId: options.requestContext?.routeId ?? null, modelId, usageTokens: totalTokens, actualCost },
            modelId || options.displayInfo?.modelId,
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
            userName,
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

        // 免计费平台：仅回复图片数量，不显示任何积分/试用/余额信息
        if (freePlatform) {
          return formatUserScopedText(
            session,
            ['生成完成', '', `- 图片｜${generatedImages.length} 张`].join('\n'),
            userId,
            userName,
          )
        }

        // 可选：附带积分提示
        // showCreditCostInResult 是总开关（"生成完成后显示本次消耗和剩余积分"）
        // showQuotaInImageCommands 是子开关，在总开关开启时额外控制是否显示剩余积分明细
        if (config.showCreditCostInResult) {
          try {
            const summary = await service.getQuotaSummary(userId, userName)
            const lines = [
              '生成完成',
              '',
              `- 图片｜${generatedImages.length} 张`,
            ]
            if (usageResult?.isTrial) {
              const trialLimit = config.trialImageLimit ?? 3
              const used = trialLimit - (summary.trialRemaining ?? trialLimit)
              const trialDisplay = Math.min(used, trialLimit)
              const remaining = Math.max(0, trialLimit - trialDisplay)
              lines.push(`- 试用额度｜${trialDisplay}/${trialLimit} 张（本次免费）`)
            } else {
              lines.push(`- 本次消耗｜${service.formatCredits(usageResult?.settledCredits ?? 0)}`)
            }
            if (config.showQuotaInImageCommands) {
              lines.push(
                `- 已购余额｜${service.formatCredits(summary.purchasedCredits)}`,
                `- 合计可用｜${service.formatCredits(summary.totalAvailable)}`,
              )
            }
            return formatUserScopedText(session, lines.join('\n'), userId, userName)
          } catch {
            return ''
          }
        }
        return ''
      }

      if (!freePlatform) {
        await service.releaseReservation(requestId, 'provider returned no images')
      }
      return sendFinalText(
        session,
        ['生成失败', '', '- 原因｜未返回图片', '- 建议｜稍后重试或调整描述'].join('\n'),
        userId,
        '发送生成失败提示失败',
        userName,
      )
    } catch (error) {
      if (!freePlatform) {
        try { await service.releaseReservation(requestId, error instanceof Error ? error.message : String(error)) } catch { /* no active reservation */ }
      }
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
              userName,
            )
          }
        } catch (recordErr) {
          logger.error('记录安全阻断失败', {
            userId,
            ...sanitizeForLog(recordErr),
          })
        }
      }

      const raw = error instanceof Error ? error.message : String(error)
      const message = sanitizeString(raw)
      return sendFinalText(
        session,
        ['生成失败', '', `- 原因｜${message}`].join('\n'),
        userId,
        '发送生成失败提示失败',
        userName,
      )
    } finally {
      generationActive = false
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
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
    options?: ExecuteImageToImageOptions,
  ): Promise<string> {
    const config = getConfig()
    const collected = await collectImageInput(session, imgParam, initialPrompt, options)
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
    options?: ExecuteComposeImageOptions,
  ): Promise<string> {
    const config = getConfig()
    const collected = await collectComposeInput(session, initialPrompt, options)
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

  return {
    executeTextToImage,
    executeImageToImage,
    executeComposeImage,
  }
}

/**
 * 动态倍率预估价（包装 computeUpperBoundSupplierCredits 为 GenerationCost）。
 * ratioOverride 优先：mapping.ratioOverride；否则取 enable_groups 表上界。
 */
function estimatePreGenerationCostWithDynamicUpper(
  modelId: string,
  config: Config,
  catalogModels: CatalogModelForPricing[],
  groupRatioMap: Record<string, number> | undefined,
  ratioOverride: number | undefined,
): GenerationCost {
  const supplierCredits = computeUpperBoundSupplierCredits(
    modelId,
    catalogModels,
    groupRatioMap,
    1,
    ratioOverride,
    { quotaPerUnit: config.quotaPerUnit, perTokenEstimate: config.perTokenEstimateTokens },
  )
  const totalCredits = computePostGenerationCost(supplierCredits, config)
  return {
    totalCredits,
    creditCostPerImage: totalCredits,
    numImages: 1,
    modelId,
    costSource: 'post-generation',
  }
}

/**
 * 解析实际路由分组倍率（结算路径）：优先级
 *   1. x-routing-group 响应头命中 groupRatioMap → 表值（真实路由证据最优）
 *   2. ratioOverride（mapping.ratioOverride 或 MJ 协议默认因子）→ 覆盖值
 *   3. groupRatioMap.default → default 值
 *   4. 1（最终兜底）
 */
function resolveActualRoutingRatio(
  routingGroup: string | null | undefined,
  groupRatioMap: Record<string, number> | undefined,
  ratioOverride: number | undefined,
): number {
  if (routingGroup && groupRatioMap) {
    const direct = groupRatioMap[routingGroup]
    if (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0) return direct
  }
  if (typeof ratioOverride === 'number' && Number.isFinite(ratioOverride) && ratioOverride > 0) {
    return ratioOverride
  }
  if (groupRatioMap) {
    const def = groupRatioMap['default']
    if (typeof def === 'number' && Number.isFinite(def) && def >= 0) return def
  }
  return 1
}

/**
 * 解析模型有效的 ratioOverride：mapping.ratioOverride > undefined。
 * undefined 表示无覆盖，交由 resolveActualRoutingRatio / computeUpperBoundSupplierCredits 按表兜底。
 * （MJ 与其它 per-call 模型一致，用表内 enable_groups × pricePerCall；无需协议特判。）
 */
function resolveEffectiveRatioOverride(
  _modelId: string,
  mapping: ModelMappingConfig | undefined,
  _catalogModels: CatalogModelForPricing[],
): number | undefined {
  const override = mapping?.ratioOverride
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override
  return undefined
}
