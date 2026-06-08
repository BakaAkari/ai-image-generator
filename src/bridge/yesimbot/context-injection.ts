/**
 * YesImBot 上下文注入。
 *
 * 在 context:build 事件中注入 AIGC 上下文：
 * - 上一张图像的引用信息 ([AIGC_CONTEXT])
 * - 风格推荐候选 ([AIGC_STYLE_CANDIDATES])
 *
 * 与 ChatLuna 版本的差异：
 * - 通过 ExtensionAPI.on('context:build', ...) 而非 ctx.on('chatluna/before-chat', ...)
 * - event.messages 是 AgentMessage[]，直接操作数组
 * - 注入方式：在 messages 头部插入 system message
 */

import type { AiImageGeneratorService } from '../../service/AiImageGeneratorService.js'
import type { Config } from '../../shared/config.js'
import type { ExtensionAPILike, ExtensionContextLike } from './runtime.js'
import type { YesImBotContextEventLike, YesImBotSessionLike } from './types.js'

export function installYesImBotContextInjection(
  api: ExtensionAPILike,
  aiGenerator: AiImageGeneratorService,
  config: Config,
  logger: (...args: any[]) => void,
): void {
  api.on('context:build', async (event: YesImBotContextEventLike, extensionCtx: ExtensionContextLike) => {
    if (!config.yesimbotContextInjectionEnabled) {
      return undefined
    }

    const session = extractSessionFromContext(extensionCtx)
    const conversationId = aiGenerator.buildSessionConversationId(session as any)
    if (!conversationId) return undefined

    const context = aiGenerator.getConversationImageContext(conversationId)
    if (!context || context.recentRecords.length === 0) return undefined

    const recentRecords = context.recentRecords.slice(-config.yesimbotContextHistorySize)
    const contextMessage = buildContextMessage(recentRecords, config)

    // 检查是否已经注入过，避免重复
    const hasExisting = (event.messages as any[]).some(
      (m: any) =>
        m?.role === 'system' &&
        typeof m?.content === 'string' &&
        m.content.includes('[AIGC_CONTEXT]'),
    )
    if (hasExisting) return undefined

    // 在 messages 头部插入 system message
    ;(event.messages as any[]).unshift({
      role: 'system',
      content: contextMessage,
    })

    logger(
      'YesImBot context injected: conversationId=%s, %d records',
      conversationId,
      recentRecords.length,
    )

    return { messages: event.messages }
  })
}

// ---------------------------------------------------------------------------
// Session 提取
// ---------------------------------------------------------------------------

function extractSessionFromContext(ctx: ExtensionContextLike): YesImBotSessionLike {
  let userId = 'unknown'
  let channelId = 'unknown'
  let platform = 'yesimbot'
  let isDirect = false
  let username: string | undefined
  let guildId: string | undefined
  let content = ''
  let timestamp = Date.now()

  try {
    const sessionManager = ctx.sessionManager as Record<string, unknown> | undefined
    if (sessionManager) {
      const currentSession =
        (sessionManager as any).currentSession || (sessionManager as any).session
      if (currentSession) {
        userId = (currentSession.userId as string) || userId
        channelId = (currentSession.channelId as string) || channelId
        platform = (currentSession.platform as string) || platform
        isDirect = (currentSession.isDirect as boolean) || false
        username = currentSession.username as string | undefined
        guildId = currentSession.guildId as string | undefined
        content = (currentSession.content as string) || ''
        timestamp = (currentSession.timestamp as number) || Date.now()
      }
    }
  } catch {
    // 防御性处理
  }

  return { userId, username, channelId, guildId, platform, isDirect, content, timestamp }
}

// ---------------------------------------------------------------------------
// 上下文消息构建
// ---------------------------------------------------------------------------

function buildContextMessage(
  records: any[],
  config: Config,
): string {
  const lines = [
    '[AIGC_CONTEXT]',
    'You have access to an AI image generation plugin. The user has previously generated images:',
    '',
  ]

  records.forEach((record, index) => {
    lines.push(`${index + 1}. ${record.prompt || '(no description)'}`)
    lines.push(`   - Image URL: ${record.imageUrl}`)
    if (record.stylePreset) {
      lines.push(`   - Style: ${record.stylePreset}`)
    }
    lines.push(`   - Time: ${new Date(record.timestamp).toLocaleString()}`)
    lines.push('')
  })

  lines.push(
    'When the user asks to edit or modify an image, use the above image URLs as references.',
  )
  lines.push(
    'Use aigc_edit_image with referenceMode=last_generated to continue from the most recent image.',
  )
  lines.push('[/AIGC_CONTEXT]')

  return lines.join('\n')
}
