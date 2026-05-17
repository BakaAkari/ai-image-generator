import type { Context } from 'koishi'

import type { Config } from '../shared/config.js'
import { COMMANDS } from '../shared/constants.js'

export interface RegisterHelpCommandsParams {
  ctx: Context
  getConfig: () => Config
}

export function registerHelpCommands(params: RegisterHelpCommandsParams) {
  const { ctx, getConfig } = params

  ctx.command(`${COMMANDS.IMAGE_HELP}`, '查看图像生成命令说明')
    .action(() => buildImageHelp(getConfig()))

  ctx.command(`${COMMANDS.PARAM_HELP}`, '查看图像生成参数说明')
    .action(() => buildParameterHelp(getConfig()))
}

function buildImageHelp(config: Config): string {
  const lines: string[] = [
    '图像指令',
    '',
    '核心命令：',
    `- ${COMMANDS.TXT_TO_IMG} <描述>｜根据文字描述生成图片`,
    `- ${COMMANDS.IMG_TO_IMG} [图片] <描述>｜根据单张参考图修改图片`,
    `- ${COMMANDS.COMPOSE_IMAGE} <描述>｜收集多张图片后按描述合成`,
    '',
    '快捷命令：',
  ]

  const styles = collectStyleRows(config)
  if (styles.length) {
    for (const style of styles) {
      lines.push(`- ${style.commandName}｜${formatStyleMode(style.mode)}｜${style.description || 'Prompt 预设'}`)
    }
  } else {
    lines.push('暂无，请在配置页 styles / styleGroups 中添加')
  }

  lines.push(
    '',
    `额度查询：${COMMANDS.QUERY_QUOTA}`,
    `管理员：${COMMANDS.ADMIN_QUERY} / ${COMMANDS.ADMIN_RECHARGE} / ${COMMANDS.ADMIN_DEDUCT} / ${COMMANDS.ADMIN_BILL}`,
    `参数可选项：发送 ${COMMANDS.PARAM_HELP} 查看`,
  )
  return lines.join('\n')
}

function buildParameterHelp(config: Config): string {
  const defaultNum = resolveCommandNum(config.defaultNumImages)
  const lines: string[] = [
    '图像参数',
    '',
    '通用参数：',
    `- -n <数量>｜生成数量，1-4，默认 ${defaultNum}`,
    '- -add <文本>｜追加生成要求',
    '- -模型后缀｜临时切换模型',
    '',
    '尺寸：',
    '- -1k / -2k / -4k｜预设分辨率',
    '- -1024x1024｜自定义分辨率',
    '',
    '比例：',
    '- -1:1 / -4:3 / -16:9 / -9:16 / -3:2 / -2:3｜画幅比例',
    '',
    '积分：',
    `- 默认每张｜${config.defaultCreditCostPerImage ?? 1} ${config.creditUnitName || '积分'}`,
    `- 每日免费｜${config.dailyFreeCredits ?? 0} ${config.creditUnitName || '积分'}`,
    '- 受限模型仍需白名单或管理员权限；白名单不代表免费',
  ]

  const restrictedMappings = Array.isArray(config.modelMappings)
    ? config.modelMappings.filter((mapping) => mapping?.suffix && mapping?.modelId && mapping.restricted)
    : []

  if (restrictedMappings.length) {
    lines.push('', '受限模型：')
    for (const mapping of restrictedMappings) {
      lines.push(`- ${normalizeSuffixLabel(mapping.suffix)}｜${mapping.modelId}`)
    }
  }

  return lines.join('\n')
}

function normalizeSuffixLabel(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return '-'
  return trimmed.startsWith('-') ? trimmed : `-${trimmed}`
}

function collectStyleRows(config: Config) {
  const rows: Array<{ commandName: string; mode?: string; description?: string }> = []
  const names = new Set<string>()
  const push = (style: any) => {
    if (!style?.commandName || !style?.prompt) return
    if (names.has(style.commandName)) return
    names.add(style.commandName)
    rows.push({
      commandName: style.commandName,
      mode: style.mode,
      description: style.description,
    })
  }

  if (Array.isArray(config.styles)) {
    for (const style of config.styles) push(style)
  }
  if (config.styleGroups && typeof config.styleGroups === 'object') {
    for (const group of Object.values(config.styleGroups)) {
      if (!group || !Array.isArray(group.prompts)) continue
      for (const style of group.prompts) push(style)
    }
  }
  return rows
}

function formatStyleMode(value?: string): string {
  switch (value) {
    case 'text-to-image':
      return '文生图'
    case 'compose-image':
      return '合成图'
    case 'image-to-image':
    default:
      return '图生图'
  }
}

function resolveCommandNum(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(4, Math.max(1, Math.floor(value || 1)))
}
