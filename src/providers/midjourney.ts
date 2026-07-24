/**
 * MjProvider — Midjourney + Kling 异步图像生成（yunwu 代理）。
 *
 * yunwu 将 MJ/Kling 统一封装为异步 task API：
 *   POST /mj/submit/imagine  →  { result: taskId }
 *   GET  /mj/task/{id}/fetch →  { status, imageUrl }
 *
 * yunwu MJ 端点返回 Content-Type: text/plain，需手动 JSON.parse。
 *
 * 本 Provider 在 generateImages() 内部做阻塞轮询，对外保持同步接口。
 */
import type { Context } from 'koishi'

import { BaseImageProvider } from './base.js'
import type {
  BaseProviderOptions,
  ImageGeneratedCallback,
  ImageGenerationOptions,
} from './types.js'

interface MjSubmitResponse {
  code?: number
  description?: string
  result?: string
}

interface MjTaskResponse {
  status: string
  imageUrl?: string
  failReason?: string
  progress?: string
}

export function createMjProvider(
  ctx: Context,
  config: Record<string, unknown>,
): MjProvider {
  return new MjProvider({
    ctx,
    apiKey: (config.apiKey as string) || '',
    modelId: (config.modelId as string) || '',
    apiBase: (config.apiBase as string) || 'https://yunwu.ai',
    apiTimeout: (config.apiTimeout as number) || 300,
    extraHeaders: (config.extraHeaders as Record<string, string>) || {},
  })
}

export class MjProvider extends BaseImageProvider {
  override readonly name = 'mj'

  private readonly POLL_INTERVAL_MS = 3000
  private readonly TASK_TIMEOUT_MS = 300_000

  constructor(options: BaseProviderOptions) {
    super(options)
  }

  async generateImages(
    prompt: string,
    imageUrls: string | string[],
    numImages: number,
    options?: ImageGenerationOptions,
    onImageGenerated?: ImageGeneratedCallback,
  ): Promise<string[]> {
    const hasInput = Array.isArray(imageUrls) ? imageUrls.length > 0 : !!imageUrls

    if (this.shouldLogDetail()) {
      this.logger.info(
        'provider=%s event=generate_detail has_input=%s num=%d model=%s',
        this.name, hasInput, numImages, this.modelId,
      )
    }

    try {
      const refs = hasInput ? (Array.isArray(imageUrls) ? imageUrls : [imageUrls as string]) : undefined
      const taskId = await this.submitTask(prompt, refs)
      const imageUrl = await this.pollTask(taskId)

      if (onImageGenerated) {
        await onImageGenerated(imageUrl, 0, 1)
      }

      this.logger.info('provider=%s event=generate_success model=%s images=1', this.name, this.modelId)
      return [imageUrl]
    } catch (error) {
      this.logger.error('provider=%s event=generate_failed model=%s error=%s',
        this.name, this.modelId, error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  private async submitTask(prompt: string, referenceImages?: string[]): Promise<string> {
    const endpoint = `${this.apiBase}/mj/submit/imagine`

    const payload: Record<string, unknown> = { prompt, model: this.modelId }
    if (referenceImages?.length) {
      payload.imageUrl = referenceImages.length === 1 ? referenceImages[0] : referenceImages
    }

    // yunwu MJ 端点返回 text/plain，需手动 parse
    const raw = await this.callApi<unknown>(() =>
      (this.ctx.http as unknown as {
        post: (url: string, body: unknown, opts: Record<string, unknown>) => Promise<unknown>
      }).post(endpoint, payload, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        timeout: 60_000,
      })
    )

    const response: MjSubmitResponse = typeof raw === 'string' ? JSON.parse(raw) : (raw as MjSubmitResponse)

    if (!response.result) {
      throw new Error(`MJ 提交失败：${response.description || '无 task_id'}`)
    }

    return response.result
  }

  private async pollTask(taskId: string): Promise<string> {
    const endpoint = `${this.apiBase}/mj/task/${taskId}/fetch`
    const start = Date.now()

    while (Date.now() - start < this.TASK_TIMEOUT_MS) {
      const task = await this.callApi<MjTaskResponse>(() =>
        (this.ctx.http as unknown as {
          get: (url: string, opts: Record<string, unknown>) => Promise<MjTaskResponse>
        }).get(endpoint, {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          timeout: 30_000,
        })
      )

      if (task.status === 'SUCCESS' && task.imageUrl) {
        return task.imageUrl
      }

      if (task.status === 'FAILURE') {
        throw new Error(`MJ 生成失败：${task.failReason || '未知错误'}`)
      }

      await new Promise(resolve => setTimeout(resolve, this.POLL_INTERVAL_MS))
    }

    throw new Error(`MJ 任务超时（${this.TASK_TIMEOUT_MS / 1000}s）`)
  }
}
