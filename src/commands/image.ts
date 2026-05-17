/**
 * 图像命令族：核心文生图 / 图生图 / 合成图、额度查询与 styles 快捷命令。
 *
 * 设计要点：
 * - 核心命令保持无前缀直呼格式，例如 `文生图` / `图生图` / `合成图` / `图像额度`。
 * - styles 命令由配置动态注册，按 `mode` 分发到对应生成链路。
 * - 模型选择优先级：用户显式模型后缀 > style 默认模型后缀 > 插件默认模型。
 */

import { h } from 'koishi'
import type { Argv, Command, Context, Session } from 'koishi'

import type { Config } from '../shared/config.js'
import { COMMANDS } from '../shared/constants.js'
import type { ImageGenerationHandlers } from '../orchestrators/ImageGenerationOrchestrator.js'
import type { AiImageGeneratorService } from '../service/AiImageGeneratorService.js'
import type {
  ImageGenerationModifiers,
  ModelMappingConfig,
  ResolvedStyleConfig,
  StyleMode,
} from '../shared/types.js'
import type { CreditLedgerEventV2 } from '../services/UserManager.js'
import {
  buildModelMappingIndex,
  normalizeSuffix,
  parseStyleCommandModifiers,
} from '../utils/parser.js'

export interface RegisterImageCommandsParams {
  ctx: Context
  service: AiImageGeneratorService
  handlers: ImageGenerationHandlers
  getConfig: () => Config
}

export interface RegisteredImageCommands {
  refreshStyleCommands: () => void
}

export function registerImageCommands(params: RegisterImageCommandsParams): RegisteredImageCommands {
  const { ctx, service, handlers, getConfig } = params
  const logger = ctx.logger('aka-ai-image-generator')

  // ---------------------------------------------------------------------------
  // 文生图：文生图 [-n 数量|-1k|-16:9|-add ...] <prompt:text>
  // ---------------------------------------------------------------------------
  ctx.command(`${COMMANDS.TXT_TO_IMG} [prompt:text]`, '文生图')
    .alias('t2i')
    .option('num', '-n <num:number> 生成图片数量（1-4）')
    .action(async (argv: Argv, prompt?: string) => {
      const session = argv.session
      if (!session) return ''

      const config = getConfig()
      const modifiers = buildCommandModifiers(argv, undefined, config)
      const access = service.checkModelAccess(session.userId || 'unknown', modifiers)
      if (!access.allowed) return access.message || ['模型受限', '', '- 要求｜管理员或模型白名单'].join('\n')

      const setup = service.buildGenerationSetup(
        resolveCommandNum(getCommandOptionNumber(argv, 'num'), config.defaultNumImages || 1),
        modifiers,
      )

      return handlers.executeTextToImage(
        session,
        prompt,
        setup.requestContext,
        setup.displayInfo,
      )
    })

  // ---------------------------------------------------------------------------
  // 图生图：图生图 [-n 数量|-1k|-16:9|-add ...] [img] [prompt:text]
  // ---------------------------------------------------------------------------
  ctx.command(`${COMMANDS.IMG_TO_IMG} [img] [prompt:text]`, '图生图')
    .alias('i2i')
    .option('num', '-n <num:number> 生成图片数量（1-4）')
    .action(async (argv: Argv, img?: unknown, prompt?: string) => {
      const session = argv.session
      if (!session) return ''

      const config = getConfig()
      const modifiers = buildCommandModifiers(argv, img, config)
      const access = service.checkModelAccess(session.userId || 'unknown', modifiers)
      if (!access.allowed) return access.message || ['模型受限', '', '- 要求｜管理员或模型白名单'].join('\n')

      const setup = service.buildGenerationSetup(
        resolveCommandNum(getCommandOptionNumber(argv, 'num'), config.defaultNumImages || 1),
        modifiers,
      )

      return handlers.executeImageToImage(
        session,
        img,
        prompt,
        setup.requestContext,
        setup.displayInfo,
      )
    })

  // ---------------------------------------------------------------------------
  // 合成图：合成图 [-n 数量|-1k|-16:9|-add ...]
  // ---------------------------------------------------------------------------
  ctx.command(`${COMMANDS.COMPOSE_IMAGE} [prompt:text]`, '合成多张图片')
    .alias('compose-image')
    .option('num', '-n <num:number> 生成图片数量（1-4）')
    .action(async (argv: Argv, prompt?: string) => {
      const session = argv.session
      if (!session) return ''

      const config = getConfig()
      const modifiers = buildCommandModifiers(argv, undefined, config)
      const access = service.checkModelAccess(session.userId || 'unknown', modifiers)
      if (!access.allowed) return access.message || ['模型受限', '', '- 要求｜管理员或模型白名单'].join('\n')

      const setup = service.buildGenerationSetup(
        resolveCommandNum(getCommandOptionNumber(argv, 'num'), config.defaultNumImages || 1),
        modifiers,
      )

      return handlers.executeComposeImage(
        session,
        prompt,
        setup.requestContext,
        setup.displayInfo,
      )
    })

  const refreshStyleCommands = registerStyleCommands({
    ctx,
    service,
    handlers,
    getConfig,
    logger,
  })

  // ---------------------------------------------------------------------------
  // 管理员查询：图像查询 @用户
  // ---------------------------------------------------------------------------
  ctx.command(`${COMMANDS.ADMIN_QUERY} [target:text]`, '管理员查询用户图像用量')
    .action(async (argv: Argv, target?: string) => {
      const session = argv.session
      if (!session) return ''

      const config = getConfig()
      if (!service.userManager.isAdmin(session.userId || 'unknown', config)) {
        return ['权限不足', '', '- 命令｜图像查询', '- 要求｜管理员'].join('\n')
      }

      const targetUser = parseMentionTarget(target || session.content || '')
      if (!targetUser?.userId) return '请使用｜图像查询 @用户'

      const summary = await service.getExistingUsageSummary(targetUser.userId)
      if (!summary) return [
        '图像查询',
        '',
        `- 用户｜${targetUser.userName || targetUser.userId}`,
        '- 状态｜暂无图像积分数据',
      ].join('\n')

      const lines = [
        '图像查询',
        '',
        `- 用户｜${summary.userName || targetUser.userName || targetUser.userId}`,
        `- 今日免费｜${service.formatCredits(summary.dailyFreeRemaining)}`,
        `- 已购余额｜${service.formatCredits(summary.purchasedCredits)}`,
        `- 合计可用｜${service.formatCredits(summary.totalAvailable)}`,
        `- 已生成｜${summary.totalImagesGenerated} 张`,
        `- 历史消耗｜${service.formatCredits(summary.totalConsumedCredits)}`,
        `- 累计充值｜${service.formatCredits(summary.totalGrantedCredits)}`,
      ]
      if (summary.estimatedCny !== undefined) {
        lines.push(`- 余额估算｜约 ${summary.estimatedCny} 元`)
      }
      return lines.join('\n')
    })

  // ---------------------------------------------------------------------------
  // 管理员排行榜：图像排行榜 [-n 数量]
  // ---------------------------------------------------------------------------
  ctx.command(`${COMMANDS.USAGE_RANKING}`, '管理员查看用户图像用量排行榜')
    .option('num', '-n <num:number> 显示数量（1-50）')
    .action(async (argv: Argv) => {
      const session = argv.session
      if (!session) return ''

      const config = getConfig()
      if (!service.userManager.isAdmin(session.userId || 'unknown', config)) {
        return ['权限不足', '', '- 命令｜图像排行榜', '- 要求｜管理员'].join('\n')
      }

      const rows = await service.getUsageRanking(resolveRankingLimit(getCommandOptionNumber(argv, 'num')))
      if (!rows.length) return ['图像排行榜', '', '- 状态｜暂无图像积分数据'].join('\n')
      return [
        '图像排行榜',
        '',
        ...rows.map(row => `- ${row.userName}｜生成 ${row.totalImagesGenerated} 张｜消耗 ${service.formatCredits(row.totalConsumedCredits)}｜余额 ${service.formatCredits(row.totalAvailable)}`),
      ].join('\n')
    })

  // ---------------------------------------------------------------------------
  // 管理员充值：图像充值 @用户 100 [原因]
  // ---------------------------------------------------------------------------
  ctx.command(`${COMMANDS.ADMIN_RECHARGE} [input:text]`, '管理员为用户充值图像积分')
    .action(async (argv: Argv, input?: string) => {
      const session = argv.session
      if (!session) return ''

      const config = getConfig()
      if (!service.userManager.isAdmin(session.userId || 'unknown', config)) {
        return ['权限不足', '', '- 命令｜图像充值', '- 要求｜管理员'].join('\n')
      }

      const parsed = parseCreditCommandInput(input || session.content || '', COMMANDS.ADMIN_RECHARGE)
      if (!parsed.target?.userId || !parsed.amount) return '请使用｜图像充值 @用户 积分 [原因]'

      const operator = {
        userId: session.userId || 'unknown',
        userName: session.username || session.author?.name || session.userId || 'unknown',
      }
      const result = await service.grantCredits(
        parsed.target.userId,
        parsed.target.userName || parsed.target.userId,
        parsed.amount,
        parsed.reason || '管理员充值',
        operator,
      )
      const summary = service.userManager.buildCreditSummary(result.userData, config)
      return [
        '图像充值完成',
        '',
        `- 用户｜${summary.userName}`,
        `- 本次充值｜${service.formatCredits(result.ledgerEvent.amount)}`,
        `- 已购余额｜${service.formatCredits(summary.purchasedCredits)}`,
        `- 合计可用｜${service.formatCredits(summary.totalAvailable)}`,
        `- 流水｜#${result.ledgerEvent.sequence}`,
      ].join('\n')
    })

  // ---------------------------------------------------------------------------
  // 管理员扣除：图像扣除 @用户 100 [原因]
  // ---------------------------------------------------------------------------
  ctx.command(`${COMMANDS.ADMIN_DEDUCT} [input:text]`, '管理员扣除用户图像积分')
    .action(async (argv: Argv, input?: string) => {
      const session = argv.session
      if (!session) return ''

      const config = getConfig()
      if (!service.userManager.isAdmin(session.userId || 'unknown', config)) {
        return ['权限不足', '', '- 命令｜图像扣除', '- 要求｜管理员'].join('\n')
      }

      const parsed = parseCreditCommandInput(input || session.content || '', COMMANDS.ADMIN_DEDUCT)
      if (!parsed.target?.userId || !parsed.amount) return '请使用｜图像扣除 @用户 积分 [原因]'

      const operator = {
        userId: session.userId || 'unknown',
        userName: session.username || session.author?.name || session.userId || 'unknown',
      }
      const result = await service.adjustCredits(
        parsed.target.userId,
        parsed.target.userName || parsed.target.userId,
        parsed.amount,
        parsed.reason || '管理员扣除',
        operator,
      )
      const summary = service.userManager.buildCreditSummary(result.userData, config)
      if (!result.ledgerEvent) {
        return [
          '扣除失败',
          '',
          `- 用户｜${summary.userName}`,
          `- 请求扣除｜${service.formatCredits(result.requestedAmount)}`,
          `- 实际扣除｜${service.formatCredits(result.deductedAmount)}`,
          `- 原因｜用户已购余额不足`,
          `- 已购余额｜${service.formatCredits(summary.purchasedCredits)}`,
          `- 合计可用｜${service.formatCredits(summary.totalAvailable)}`,
        ].join('\n')
      }

      return [
        result.isPartial ? '图像部分扣除完成' : '图像扣除完成',
        '',
        `- 用户｜${summary.userName}`,
        `- 请求扣除｜${service.formatCredits(result.requestedAmount)}`,
        `- 实际扣除｜${service.formatCredits(result.deductedAmount)}`,
        `- 已购余额｜${service.formatCredits(summary.purchasedCredits)}`,
        `- 合计可用｜${service.formatCredits(summary.totalAvailable)}`,
        `- 流水｜#${result.ledgerEvent.sequence}`,
      ].join('\n')
    })

  // ---------------------------------------------------------------------------
  // 管理员账单：图像账单 [@用户] [-n 数量]
  // ---------------------------------------------------------------------------
  ctx.command(`${COMMANDS.ADMIN_BILL} [target:text]`, '管理员查看图像积分流水')
    .option('num', '-n <num:number> 显示数量（1-50）')
    .action(async (argv: Argv, target?: string) => {
      const session = argv.session
      if (!session) return ''

      const config = getConfig()
      if (!service.userManager.isAdmin(session.userId || 'unknown', config)) {
        return ['权限不足', '', '- 命令｜图像账单', '- 要求｜管理员'].join('\n')
      }

      const targetUser = parseMentionTarget(target || session.content || '')
      const limit = resolveRankingLimit(getCommandOptionNumber(argv, 'num'))
      const events = await service.listLedgerEvents(targetUser?.userId, limit)
      if (!events.length) return [
        '图像账单',
        '',
        targetUser?.userId ? `- 用户｜${targetUser.userName || targetUser.userId}` : '- 范围｜全部用户',
        '- 状态｜暂无积分流水',
      ].join('\n')

      return [
        '图像账单',
        '',
        targetUser?.userId ? `- 用户｜${targetUser.userName || targetUser.userId}` : '- 范围｜全部用户',
        ...events.map(event => formatLedgerEvent(event, service.formatCredits.bind(service))),
      ].join('\n')
    })

  // ---------------------------------------------------------------------------
  // 额度查询：图像额度
  // ---------------------------------------------------------------------------
  ctx.command(`${COMMANDS.QUERY_QUOTA}`, '查询当前额度')
    .alias('quota')
    .action(async (argv: Argv) => {
      const session: Session | undefined = argv.session
      if (!session) return ''
      return handlers.executeQueryQuota(session)
    })

  return { refreshStyleCommands }
}

interface RegisterStyleCommandsParams extends RegisterImageCommandsParams {
  logger: ReturnType<Context['logger']>
}

function registerStyleCommands(params: RegisterStyleCommandsParams): () => void {
  const { logger } = params
  let registeredCommands: Command[] = []

  const refresh = () => {
    for (const command of registeredCommands) command.dispose()
    registeredCommands = []

    const reservedNames = new Set<string>([
      COMMANDS.TXT_TO_IMG,
      COMMANDS.IMG_TO_IMG,
      COMMANDS.COMPOSE_IMAGE,
      COMMANDS.QUERY_QUOTA,
      COMMANDS.ADMIN_QUERY,
      COMMANDS.USAGE_RANKING,
      COMMANDS.ADMIN_RECHARGE,
      COMMANDS.ADMIN_DEDUCT,
      COMMANDS.ADMIN_BILL,
      COMMANDS.IMAGE_HELP,
      COMMANDS.PARAM_HELP,
    ])

    for (const style of params.service.listStylePresets()) {
      const command = registerStyleCommand(params, style, reservedNames)
      if (command) registeredCommands.push(command)
    }

    logger.info('style 命令刷新完成', { count: registeredCommands.length })
  }

  refresh()
  return refresh
}

function registerStyleCommand(
  params: RegisterStyleCommandsParams,
  style: ResolvedStyleConfig,
  reservedNames: Set<string>,
): Command | undefined {
  const { ctx, service, handlers, getConfig, logger } = params
  if (!style.commandName || !style.prompt) return undefined
  if (reservedNames.has(style.commandName)) {
    logger.warn('跳过与核心命令冲突的 style 命令', { commandName: style.commandName })
    return undefined
  }
  reservedNames.add(style.commandName)

  const command = ctx.command(`${style.commandName} [img] [prompt:text]`, style.description || 'Prompt 预设')
    .option('num', '-n <num:number> 生成图片数量（1-4）')
    .action(async (argv: Argv, img?: unknown, prompt?: string) => {
      const session = argv.session
      if (!session) return ''

      const config = getConfig()
      const modifiers = buildCommandModifiers(argv, img, config, style)
      const access = service.checkModelAccess(session.userId || 'unknown', modifiers)
      if (!access.allowed) return access.message || ['模型受限', '', '- 要求｜管理员或模型白名单'].join('\n')

      const setup = service.buildGenerationSetup(
        resolveCommandNum(getCommandOptionNumber(argv, 'num'), config.defaultNumImages || 1),
        modifiers,
      )
      const finalPrompt = mergePrompt(style.prompt, prompt, modifiers.customAdditions)
      const mode = resolveStyleMode(style.mode)

      if (mode === 'text-to-image') {
        return handlers.executeTextToImage(
          session,
          finalPrompt,
          setup.requestContext,
          setup.displayInfo,
          style.commandName,
          style.commandName,
        )
      }
      if (mode === 'compose-image') {
        return handlers.executeComposeImage(
          session,
          finalPrompt,
          setup.requestContext,
          setup.displayInfo,
          style.commandName,
          style.commandName,
        )
      }
      return handlers.executeImageToImage(
        session,
        img,
        finalPrompt,
        setup.requestContext,
        setup.displayInfo,
        style.commandName,
        style.commandName,
      )
    })

  logger.info('已注册 style 命令', {
    commandName: style.commandName,
    groupName: style.groupName || '',
    mode: resolveStyleMode(style.mode),
    modelSuffix: style.modelSuffix || '',
  })
  return command
}

function buildCommandModifiers(
  argv: Argv,
  imgParam: unknown,
  config: Config,
  style?: ResolvedStyleConfig,
): ImageGenerationModifiers {
  const modelIndex = buildModelMappingIndex(config.modelMappings)
  const modifiers = parseStyleCommandModifiers(argv, imgParam, modelIndex)
  if (!modifiers.modelMapping) {
    const defaultMapping = resolveStyleModelMapping(style, modelIndex)
    if (defaultMapping) modifiers.modelMapping = defaultMapping
  }
  return modifiers
}

function resolveStyleModelMapping(
  style: ResolvedStyleConfig | undefined,
  modelIndex: Map<string, ModelMappingConfig>,
): ModelMappingConfig | undefined {
  const key = normalizeSuffix(style?.modelSuffix)
  return key ? modelIndex.get(key) : undefined
}

function resolveStyleMode(mode: StyleMode | undefined): StyleMode {
  return mode || 'image-to-image'
}

function mergePrompt(
  basePrompt: string,
  prompt: string | undefined,
  additions: string[] | undefined,
): string {
  return [basePrompt, prompt, ...(additions || [])]
    .map(item => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)
    .join(' - ')
}

function parseMentionTarget(input: string): { userId: string; userName?: string } | undefined {
  const elements = h.parse(input || '')
  const at = h.select(elements, 'at')[0]
  const id = at?.attrs?.id || at?.attrs?.user_id
  if (!id || id === 'all') return undefined
  const name = typeof at.attrs?.name === 'string' && at.attrs.name.trim()
    ? at.attrs.name.trim()
    : undefined
  return {
    userId: String(id),
    ...(name !== undefined ? { userName: name } : {}),
  }
}

function parseCreditCommandInput(input: string, commandName: string): {
  target?: { userId: string; userName?: string }
  amount?: number
  reason?: string
} {
  const withoutCommand = String(input || '').replace(commandName, '').trim()
  const target = parseMentionTarget(withoutCommand)
  const withoutAtTags = withoutCommand.replace(/<at\b[^>]*>/g, ' ').replace(/<at\b[^>]*\/>/g, ' ')
  const amountMatch = withoutAtTags.match(/(?:^|\s)(\d+(?:\.\d+)?)(?:\s|$)/)
  const amount = amountMatch ? Number(amountMatch[1]) : undefined
  const reason = amountMatch
    ? withoutAtTags.slice((amountMatch.index || 0) + amountMatch[0].length).trim()
    : ''
  return {
    ...(target ? { target } : {}),
    ...(amount !== undefined && Number.isFinite(amount) && amount > 0 ? { amount } : {}),
    ...(reason ? { reason } : {}),
  }
}

function formatLedgerEvent(event: CreditLedgerEventV2, formatCredits: (value: number) => string): string {
  const time = typeof event.timestamp === 'string'
    ? event.timestamp.replace('T', ' ').slice(0, 16)
    : ''
  const label = resolveLedgerTypeLabel(event.type)
  const detail = event.generation?.numImages
    ? `｜${event.generation.commandName || '生成'} ${event.generation.numImages} 张`
    : ''
  return `- #${event.sequence}｜${time}｜${event.userName || event.userId}｜${label} ${formatCredits(event.amount)}${detail}`
}

function resolveLedgerTypeLabel(type: CreditLedgerEventV2['type']): string {
  switch (type) {
    case 'grant': return '充值'
    case 'consume': return '消费'
    case 'refund': return '退款'
    case 'adjust': return '调整'
    case 'daily-reset': return '重置'
    case 'migration': return '迁移'
    default: return type || '流水'
  }
}

function resolveRankingLimit(rawValue: number | undefined): number {
  const value = typeof rawValue === 'number' && Number.isFinite(rawValue)
    ? Math.floor(rawValue)
    : 10
  return Math.min(50, Math.max(1, value || 10))
}

function getCommandOptionNumber(argv: Argv, key: string): number | undefined {
  const options = argv.options as Record<string, unknown> | undefined
  const value = options?.[key]
  return typeof value === 'number' ? value : undefined
}

function resolveCommandNum(rawValue: number | undefined, fallback: number): number {
  const value = typeof rawValue === 'number' && Number.isFinite(rawValue)
    ? Math.floor(rawValue)
    : Math.floor(fallback)
  return Math.min(4, Math.max(1, value || 1))
}

