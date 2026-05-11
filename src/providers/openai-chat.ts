import type { Context } from 'koishi'

import { BaseImageProvider } from './base.js'
import { ContentFilterError, ParseError, ProviderError } from './errors.js'
import type {
  BaseProviderOptions,
  ImageGeneratedCallback,
  ImageGenerationOptions,
} from './types.js'
import { sanitizeError, sanitizeString } from './utils.js'

/**
 * OpenAI Chat Completions 多模态图像 Provider。
 *
 * 用于云雾 / Packy / 米醋等第三方 OpenAI-compatible 站点暴露的
 * `/v1/chat/completions` 图像生成兼容接口，重点覆盖 Gemini Banana 类模型。
 */
export type OpenAIChatImageProviderOptions = BaseProviderOptions

const DEFAULT_API_BASE = 'https://api.openai.com/v1'

interface ChatCompletionResponse {
  error?: { message?: string; type?: string; code?: string }
  choices?: Array<{
    message?: {
      content?: unknown
      images?: unknown
    }
    delta?: {
      content?: unknown
    }
  }>
  data?: unknown
  images?: unknown
  output?: unknown
}

export class OpenAIChatImageProvider extends BaseImageProvider {
  override readonly name = 'openai-chat'

  override async generateImages(
    prompt: string,
    imageUrls: string | string[],
    numImages: number,
    options?: ImageGenerationOptions,
    onImageGenerated?: ImageGeneratedCallback
  ): Promise<string[]> {
    const urls = Array.isArray(imageUrls) ? imageUrls : [imageUrls]
    const validUrls = urls.filter((url) => typeof url === 'string' && url.trim().length > 0)
    const allImages: string[] = []

    for (let i = 0; i < numImages; i++) {
      const response = await this.callApi<ChatCompletionResponse>(() =>
        (this.ctx.http as unknown as {
          post: (url: string, body: unknown, opts: Record<string, unknown>) => Promise<ChatCompletionResponse>
        }).post(`${this.getApiBase()}/chat/completions`, this.buildRequestBody(prompt, validUrls, options), {
          headers: this.buildHeaders(),
          timeout: this.getTimeoutMs(),
        })
      )

      const images = parseChatImageResponse(response, this.name)
      if (images.length === 0) {
        this.logger.warn(
          'provider=%s event=chat_empty_response current=%d total=%d',
          this.name,
          i + 1,
          numImages
        )
        continue
      }

      for (const url of images) {
        const currentIndex = allImages.length
        allImages.push(url)
        await this.fireImageCallback(onImageGenerated, url, currentIndex, numImages)
      }
    }

    if (allImages.length === 0) {
      throw new ParseError('未能从 Chat Completions 响应中解析到图片', { providerName: this.name })
    }

    return allImages
  }

  private getApiBase(): string {
    return normalizeV1Base(this.apiBase ?? DEFAULT_API_BASE)
  }

  private buildRequestBody(
    prompt: string,
    imageUrls: string[],
    options?: ImageGenerationOptions,
  ): Record<string, unknown> {
    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: prompt },
    ]

    for (const url of imageUrls) {
      content.push({
        type: 'image_url',
        image_url: { url },
      })
    }

    const extraPromptParts: string[] = []
    if (options?.aspectRatio) extraPromptParts.push(`宽高比：${options.aspectRatio}`)
    if (options?.resolution) extraPromptParts.push(`分辨率：${options.resolution}`)
    if (extraPromptParts.length > 0) {
      content.push({
        type: 'text',
        text: `图像参数要求：${extraPromptParts.join('，')}`,
      })
    }

    return {
      model: this.modelId,
      stream: false,
      messages: [
        {
          role: 'user',
          content,
        },
      ],
    }
  }
}

function parseChatImageResponse(response: ChatCompletionResponse | undefined, providerName: string): string[] {
  if (!response || typeof response !== 'object') {
    throw new ParseError('Chat Completions API 响应为空或格式异常', { providerName })
  }

  if (response.error) {
    const errMessage = sanitizeString(response.error.message ?? JSON.stringify(sanitizeError(response.error)))
    if (isContentFilter(errMessage)) {
      throw new ContentFilterError(errMessage, { providerName })
    }
    throw new ProviderError('UNKNOWN', `Chat Completions API 错误: ${errMessage}`, { providerName })
  }

  const images = new Set<string>()
  collectImageLikeStrings(response, images)
  return Array.from(images)
}

function collectImageLikeStrings(value: unknown, images: Set<string>): void {
  if (typeof value === 'string') {
    for (const item of extractImageUrls(value)) images.add(item)
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) collectImageLikeStrings(item, images)
    return
  }

  if (!value || typeof value !== 'object') return

  const record = value as Record<string, unknown>
  for (const key of ['url', 'image_url', 'fileUri', 'file_uri', 'b64_json', 'data']) {
    const nested = record[key]
    if (typeof nested === 'string') {
      if (key === 'b64_json') images.add(`data:image/png;base64,${nested}`)
      else collectImageLikeStrings(nested, images)
    } else if (nested && typeof nested === 'object') {
      collectImageLikeStrings(nested, images)
    }
  }

  for (const nested of Object.values(record)) {
    if (nested && typeof nested === 'object') collectImageLikeStrings(nested, images)
  }
}

function extractImageUrls(text: string): string[] {
  const results: string[] = []
  const dataUrlRegex = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g
  const urlRegex = /https?:\/\/[^\s)'"<>]+/g

  for (const match of text.matchAll(dataUrlRegex)) {
    if (match[0]) results.push(match[0])
  }
  for (const match of text.matchAll(urlRegex)) {
    const url = match[0]
    if (/\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(url) || /image|img|file|cdn|oss|cos|r2|s3/i.test(url)) {
      results.push(url)
    }
  }
  return results
}

function isContentFilter(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('safety') ||
    lower.includes('content policy') ||
    lower.includes('content_policy_violation') ||
    lower.includes('blocked') ||
    lower.includes('违规') ||
    lower.includes('内容审核')
  )
}

export function createOpenAIChatImageProvider(
  ctx: Context,
  config: Record<string, unknown>
): OpenAIChatImageProvider {
  return new OpenAIChatImageProvider({
    ctx,
    apiKey: String(config.apiKey ?? ''),
    modelId: String(config.modelId ?? ''),
    apiBase: typeof config.apiBase === 'string' ? config.apiBase : undefined,
    apiTimeout: Number.isFinite(config.apiTimeout as number)
      ? Number(config.apiTimeout)
      : 60,
    logLevel: config.logLevel as BaseProviderOptions['logLevel'],
    loggerName: 'aka-ai-image-generator:openai-chat',
    extraHeaders: isRecordOfStrings(config.extraHeaders) ? config.extraHeaders : undefined,
  })
}

function normalizeV1Base(apiBase: string): string {
  const trimmed = apiBase.replace(/\/$/, '')
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === 'string')
}
