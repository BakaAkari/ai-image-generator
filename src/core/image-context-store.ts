import type { ConversationImageContext, GeneratedImageRecord } from '../shared/types.js'

export interface AddImageRecordOptions {
  maxRecordsPerConversation?: number
}

/**
 * 内存级会话图像上下文存储（cherry-pick 自 v1，仅做 NodeNext 后缀适配）。
 *
 * 用于：
 * - 记录最近一次生成的图像（lastGenerated）
 * - 维护会话级最近 N 条记录（recentRecords）
 * - 支持 ChatLuna 上下文注入与"沿用上次设定"等场景
 */
export class ImageContextStore {
  private readonly conversations = new Map<string, ConversationImageContext>()

  getConversationContext(conversationId: string) {
    return this.conversations.get(conversationId)
  }

  getLastGenerated(conversationId: string) {
    return this.conversations.get(conversationId)?.lastGenerated
  }

  addGeneratedRecord(record: GeneratedImageRecord, options: AddImageRecordOptions = {}) {
    const maxRecords = options.maxRecordsPerConversation ?? 20
    const existing = this.conversations.get(record.conversationId)
    const recentRecords = existing?.recentRecords ? [...existing.recentRecords] : []

    recentRecords.unshift(record)
    if (recentRecords.length > maxRecords) {
      recentRecords.length = maxRecords
    }

    const nextContext: ConversationImageContext = {
      conversationId: record.conversationId,
      lastGenerated: record,
      recentRecords,
      pinnedStylePreset: existing?.pinnedStylePreset,
      pinnedCharacterNotes: existing?.pinnedCharacterNotes,
      lastUpdatedAt: record.createdAt,
    }

    this.conversations.set(record.conversationId, nextContext)
    return nextContext
  }

  clearConversation(conversationId: string) {
    this.conversations.delete(conversationId)
  }

  clearAll() {
    this.conversations.clear()
  }

  pruneExpired(ttlMs: number, now = Date.now()) {
    for (const [conversationId, context] of this.conversations.entries()) {
      if (now - context.lastUpdatedAt > ttlMs) {
        this.conversations.delete(conversationId)
      }
    }
  }
}
