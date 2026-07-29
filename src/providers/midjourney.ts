/**
 * MjProvider —— Midjourney Imagine (yunwu.mj.imagine 契约)。
 *
 * 严格按云雾 Apifox 契约（5427167/232421938）发送：
 *   Body: { botType, prompt, base64Array?, notifyHook?, state? }
 *
 * 与旧版差异：
 * - 不再发送 `model` 与 `imageUrl` 字段（官方契约未声明）。
 * - 参考图先下载为 data URL 放入 base64Array（Apifox 声明 Imagine 直接接受 base64Array）；
 *   /mj/submit/upload-discord-images 仅在真实探针证明必要后接入。
 * - 非 Imagine 的 MJ Action/Blend/Describe/Kling 目前无契约，服务层 fail-closed，
 *   本 Provider 只处理 imagine 契约；其他契约 id → 抛错。
 *
 * yunwu MJ 端点返回 Content-Type: text/plain，仍需手动 JSON.parse。
 */
import type { Context } from 'koishi'

import { BaseImageProvider } from './base.js'
import { BadRequestError, ProviderError } from './errors.js'
import type {
  BaseProviderOptions,
  ImageGeneratedCallback,
  ImageGenerationOptions,
} from './types.js'
import { downloadImageAsBase64, sanitizeError, sanitizeString } from './utils.js'

interface MjSubmitResponse {
  code?: number
  description?: string
  result?: string
  properties?: Record<string, unknown>
}

interface MjTaskResponse {
  status?: string
  imageUrl?: string
  failReason?: string
  progress?: string
  description?: string
  finishTime?: number
  properties?: { finalPrompt?: string }
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
    logLevel: config.logLevel as BaseProviderOptions['logLevel'],
    loggerName: 'aka-ai-image-generator:mj',
  })
}

/** MjProvider 构造参数：允许测试通过 pollIntervalMs / taskTimeoutMs 注入更小的时间。 */
export interface MjProviderOptions extends BaseProviderOptions {
  pollIntervalMs?: number
  taskTimeoutMs?: number
}

const KNOWN_IMAGINE_CONTRACT_IDS = new Set([
  'yunwu.mj.imagine',
  'yunwu.mj.imagine.reference',
])

export class MjProvider extends BaseImageProvider {
  override readonly name = 'mj'

  private readonly pollIntervalMs: number
  private readonly taskTimeoutMs: number

  constructor(options: MjProviderOptions) {
    super(options)
    this.pollIntervalMs = options.pollIntervalMs ?? 3000
    this.taskTimeoutMs = options.taskTimeoutMs ?? 300_000
  }

  async generateImages(
    prompt: string,
    imageUrls: string | string[],
    numImages: number,
    options?: ImageGenerationOptions,
    onImageGenerated?: ImageGeneratedCallback,
  ): Promise<string[]> {
    const contract = options?.contract
    if (!contract || !KNOWN_IMAGINE_CONTRACT_IDS.has(contract.id)) {
      throw new BadRequestError(
        `当前 MJ 路由未接入契约（${contract?.id ?? 'none'}），暂不支持`,
        { providerName: this.name },
      )
    }
    if (options?.rejectedParams && options.rejectedParams.length > 0) {
      const summary = options.rejectedParams
        .map((r) => `${r.key}｜${r.reason}`)
        .join('；')
      throw new BadRequestError(`参数不被当前契约接受（rejected）：${summary}`, {
        providerName: this.name,
      })
    }

    const refs = Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : (imageUrls ? [imageUrls] : [])
    const hasInput = refs.length > 0

    if (this.shouldLogDetail()) {
      this.logger.info(
        'provider=%s event=generate_detail contract=%s has_input=%s num=%d model=%s',
        this.name, contract.id, hasInput, numImages, this.modelId,
      )
    }

    // 图生图输入：全部下载失败 → 明确失败，不退化为文生图
    let base64Array: string[] | undefined
    if (hasInput) {
      const encoded: string[] = []
      for (const url of refs) {
        try {
          const { data, mimeType } = await downloadImageAsBase64(
            this.ctx,
            url,
            this.apiTimeoutSeconds,
            this.logger,
          )
          encoded.push(`data:${mimeType};base64,${data}`)
        } catch (err) {
          this.logger.error(
            'provider=%s event=download_failed url=%s error=%s',
            this.name,
            truncate(url, 80),
            JSON.stringify(sanitizeError(err)).slice(0, 200),
          )
        }
      }
      if (encoded.length === 0) {
        throw new BadRequestError('所有输入图片下载失败，无法生成', { providerName: this.name })
      }
      base64Array = encoded
    }

    const botType = String(options?.contractFields?.botType ?? 'MID_JOURNEY')
    const results: string[] = []
    try {
      for (let i = 0; i < numImages; i++) {
        const taskId = await this.submitImagine({ prompt, botType, base64Array })
        const imageUrl = await this.pollTask(taskId)
        results.push(imageUrl)
        if (onImageGenerated) await onImageGenerated(imageUrl, results.length - 1, numImages)
      }
      this.logger.info(
        'provider=%s event=generate_success contract=%s images=%d',
        this.name, contract.id, results.length,
      )
      return results
    } catch (error) {
      const normalized = error instanceof ProviderError ? error : this.handleProviderError(error)
      this.logger.error(
        'provider=%s event=generate_failed contract=%s code=%s message=%s',
        this.name, contract.id, normalized.code, sanitizeString(normalized.message),
      )
      throw normalized
    }
  }

  // --- private helpers ------------------------------------------------------

  private async submitImagine(payload: {
    prompt: string
    botType: string
    base64Array?: string[]
  }): Promise<string> {
    const endpoint = `${this.apiBase}/mj/submit/imagine`
    const body: Record<string, unknown> = {
      botType: payload.botType,
      prompt: payload.prompt,
    }
    if (payload.base64Array && payload.base64Array.length > 0) {
      body.base64Array = payload.base64Array
    }

    if (this.shouldLogDetail()) {
      this.logger.info(
        'provider=%s event=submit_detail endpoint=%s bot_type=%s prompt_length=%d base64_count=%d',
        this.name,
        endpoint,
        payload.botType,
        payload.prompt.length,
        payload.base64Array?.length ?? 0,
      )
    }

    const raw = await this.callApi<unknown>(() =>
      (this.ctx.http as unknown as {
        post: (url: string, body: unknown, opts: Record<string, unknown>) => Promise<unknown>
      }).post(endpoint, body, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        timeout: 60_000,
      })
    )

    const response: MjSubmitResponse = typeof raw === 'string' ? safeJsonParse(raw) : (raw as MjSubmitResponse)
    if (!response?.result) {
      throw new BadRequestError(`MJ 提交失败：${response?.description || '无 task_id'}`, {
        providerName: this.name,
      })
    }
    return response.result
  }

  private async pollTask(taskId: string): Promise<string> {
    const endpoint = `${this.apiBase}/mj/task/${taskId}/fetch`
    const start = Date.now()

    while (Date.now() - start < this.taskTimeoutMs) {
      const raw = await this.callApi<unknown>(() =>
        (this.ctx.http as unknown as {
          get: (url: string, opts: Record<string, unknown>) => Promise<unknown>
        }).get(endpoint, {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          timeout: 30_000,
        })
      )
      const task: MjTaskResponse = typeof raw === 'string' ? safeJsonParse(raw) : (raw as MjTaskResponse)

      if (task?.status === 'SUCCESS' && task.imageUrl) {
        return task.imageUrl
      }
      if (task?.status === 'FAILURE') {
        const reason = task.failReason || task.description || '未知错误'
        throw new BadRequestError(`MJ 生成失败：${reason}`, { providerName: this.name })
      }

      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs))
    }

    throw new BadRequestError(`MJ 任务超时（${this.taskTimeoutMs / 1000}s）`, {
      providerName: this.name,
    })
  }
}

function safeJsonParse<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return {} as T
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}
