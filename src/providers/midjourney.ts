/**
 * MjProvider —— Midjourney Imagine / Blend 契约。
 *
 * 严格按 openlux new-api 契约发送：
 *   Imagine:  { botType, prompt, base64Array?, notifyHook?, state? } → POST /mj/submit/imagine
 *   Blend:    { botType, base64Array (2-5 张) }                    → POST /mj/submit/blend
 *
 * 与旧版差异：
 * - 不再发送 `model` 与 `imageUrl` 字段（官方契约未声明）。
 * - 参考图先下载为 data URL 放入 base64Array（Apifox 声明 Imagine 直接接受 base64Array）；
 *   /mj/submit/upload-discord-images 仅在真实探针证明必要后接入。
 * - Blend 为多图融合（compose-image），与 Imagine 垫图（reference + prompt 生成）语义分离。
 * - 非 Imagine/Blend 的 MJ Action/Describe/Kling 目前无契约，服务层 fail-closed。
 *
 * new-api MJ 端点返回 Content-Type: text/plain，仍需手动 JSON.parse。
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

/** apiBase 由 providerSettings.openaiCompatibleApiBase 传入；未配置时为空，请求失败以暴露配置缺失。 */
export function createMjProvider(
  ctx: Context,
  config: Record<string, unknown>,
): MjProvider {
  return new MjProvider({
    ctx,
    apiKey: (config.apiKey as string) || '',
    modelId: (config.modelId as string) || '',
    apiBase: (config.apiBase as string) || '',
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
  'newapi.mj.imagine',
  'newapi.mj.imagine.reference',
])

const KNOWN_BLEND_CONTRACT_IDS = new Set([
  'newapi.mj.blend',
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
    if (!contract || (!KNOWN_IMAGINE_CONTRACT_IDS.has(contract.id) && !KNOWN_BLEND_CONTRACT_IDS.has(contract.id))) {
      throw new BadRequestError(
        `当前 MJ 路由未接入契约（${contract?.id ?? 'none'}），暂不支持`,
        { providerName: this.name },
      )
    }
    const isBlend = KNOWN_BLEND_CONTRACT_IDS.has(contract.id)
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
        'provider=%s event=generate_detail contract=%s has_input=%s num=%d model=%s blend=%s',
        this.name, contract.id, hasInput, numImages, this.modelId, isBlend,
      )
    }

    // 图生图输入：全部下载失败 → 明确失败，不退化为文生图
    let base64Array: string[] | undefined
    if (hasInput) {
      const encoded: string[] = []
      let firstDownloadError: string | undefined
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
          firstDownloadError ??= err instanceof Error ? err.message : String(err)
          this.logger.error(
            'provider=%s event=download_failed url=%s error=%s',
            this.name,
            truncate(url, 80),
            JSON.stringify(sanitizeError(err)).slice(0, 200),
          )
        }
      }
      if (encoded.length === 0) {
        throw new BadRequestError(
          `所有输入图片下载失败，无法生成${firstDownloadError ? `｜${firstDownloadError}` : ''}`,
          { providerName: this.name },
        )
      }
      base64Array = encoded
    }

    // blend 至少需要 2 张图（官方 /blend 限制 2-5）
    if (isBlend && (!base64Array || base64Array.length < 2)) {
      throw new BadRequestError(
        `MJ 合成图（blend）至少需要 2 张输入图片，当前 ${base64Array?.length ?? 0} 张`,
        { providerName: this.name },
      )
    }

    const botType = String(options?.contractFields?.botType ?? 'MID_JOURNEY')
    const results: string[] = []
    try {
      for (let i = 0; i < numImages; i++) {
        let taskId: string
        if (isBlend) {
          taskId = await this.submitBlend({
            base64Array: base64Array!,
            botType,
            dimensions: dimensionsFromAspectRatio(
              String(options?.contractFields?.aspectRatio ?? options?.aspectRatio ?? ''),
            ),
          })
        } else {
          taskId = await this.submitImagine({ prompt, botType, base64Array })
        }
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

    const raw = await this.callApi<{ data: unknown; headers?: { get: (name: string) => string | null } }>(() =>
      (this.ctx.http as unknown as {
        (url: string, config: Record<string, unknown>): Promise<{ data: unknown; headers?: { get: (name: string) => string | null } }>
      })(endpoint, {
        method: 'POST',
        data: body,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        timeout: 60_000,
      })
    )

    // 捕获 new-api 路由分组（x-routing-group），供后生成结算按实际分组倍率计价
    const routingGroup = raw?.headers?.get?.('x-routing-group')?.trim()
    this.lastRoutingGroup = routingGroup && routingGroup.length > 0 ? routingGroup : null

    const response: MjSubmitResponse = typeof raw?.data === 'string' ? safeJsonParse(raw.data) : (raw?.data as MjSubmitResponse)
    if (!response?.result) {
      throw new BadRequestError(`MJ 提交失败：${response?.description || '无 task_id'}`, {
        providerName: this.name,
      })
    }
    return response.result
  }

  private async submitBlend(payload: {
    base64Array: string[]
    botType: string
    dimensions?: 'SQUARE' | 'PORTRAIT' | 'LANDSCAPE'
  }): Promise<string> {
    const endpoint = `${this.apiBase}/mj/submit/blend`
    const body: Record<string, unknown> = {
      botType: payload.botType,
      base64Array: payload.base64Array,
      dimensions: payload.dimensions ?? 'SQUARE',
    }

    if (this.shouldLogDetail()) {
      this.logger.info(
        'provider=%s event=submit_detail endpoint=%s bot_type=%s base64_count=%d',
        this.name,
        endpoint,
        payload.botType,
        payload.base64Array.length,
      )
    }

    const raw = await this.callApi<{ data: unknown; headers?: { get: (name: string) => string | null } }>(() =>
      (this.ctx.http as unknown as {
        (url: string, config: Record<string, unknown>): Promise<{ data: unknown; headers?: { get: (name: string) => string | null } }>
      })(endpoint, {
        method: 'POST',
        data: body,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        timeout: 60_000,
      })
    )

    // 捕获 new-api 路由分组（x-routing-group），供后生成结算按实际分组倍率计价
    const routingGroup = raw?.headers?.get?.('x-routing-group')?.trim()
    this.lastRoutingGroup = routingGroup && routingGroup.length > 0 ? routingGroup : null

    const response: MjSubmitResponse = typeof raw?.data === 'string' ? safeJsonParse(raw.data) : (raw?.data as MjSubmitResponse)
    if (!response?.result) {
      throw new BadRequestError(`MJ 合成提交失败：${response?.description || '无 task_id'}`, {
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

function dimensionsFromAspectRatio(value: string): 'SQUARE' | 'PORTRAIT' | 'LANDSCAPE' {
  const [wRaw, hRaw] = value.split(':')
  const w = Number(wRaw)
  const h = Number(hRaw)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 'SQUARE'
  if (w === h) return 'SQUARE'
  return w > h ? 'LANDSCAPE' : 'PORTRAIT'
}
