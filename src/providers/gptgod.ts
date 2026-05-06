import type { Context } from 'koishi'

import { BaseImageProvider } from './base.js'
import {
  BadRequestError,
  ContentFilterError,
  ParseError,
  ProviderError,
  RateLimitError,
} from './errors.js'
import type {
  BaseProviderOptions,
  ImageGeneratedCallback,
  ImageGenerationOptions,
} from './types.js'
import { downloadImageAsBase64, sanitizeError, sanitizeString } from './utils.js'

/**
 * GptGodProvider 配置
 *
 * 复用 BaseProviderOptions 全部字段。
 */
export type GptGodProviderOptions = BaseProviderOptions

const DEFAULT_API_BASE = 'https://api.gptgod.online'
const CHAT_COMPLETIONS_PATH = '/v1/chat/completions'

const HTTP_URL_REGEX = /^https?:\/\//i
const DATA_URL_REGEX = /^data:image\//i

/**
 * GptGodProvider（v2 重写版）
 *
 * 使用 OpenAI Chat Completions 协议，模型自动识别图像生成意图。
 * 端点：POST {apiBase}/v1/chat/completions
 *
 * 关键能力：
 * - 输入图片以 image_url 形式追加到 user message 的 content parts
 * - 远程 URL 直接传递，本地资源/data URL 转 base64 内嵌
 * - 强制识别 PROHIBITED_CONTENT / blocked by Google Gemini 等内容拦截
 * - 5xx / Socket / fetch 错误由基类 retry 策略处理
 */
export class GptGodProvider extends BaseImageProvider {
  override readonly name = 'gptgod'

  override async generateImages(
    prompt: string,
    imageUrls: string | string[],
    numImages: number,
    options?: ImageGenerationOptions,
    onImageGenerated?: ImageGeneratedCallback
  ): Promise<string[]> {
    const urls = Array.isArray(imageUrls) ? imageUrls : [imageUrls]
    const validUrls = urls.filter((url) => url && typeof url === 'string' && url.trim().length > 0)

    if (!this.apiKey) {
      throw new BadRequestError('GPTGod 配置不完整，请检查 API Key', { providerName: this.name })
    }

    this.logger.debug(
      'provider=%s event=generate_start has_input=%s input_count=%d num=%d model=%s aspect=%s resolution=%s',
      this.name,
      validUrls.length > 0,
      validUrls.length,
      numImages,
      this.modelId,
      options?.aspectRatio ?? '-',
      options?.resolution ?? '-'
    )

    // 预先把所有输入图片转换为 chat completions 的 image_url part
    const imageParts: Array<{ type: 'image_url'; image_url: { url: string } }> = []
    for (const url of validUrls) {
      try {
        const part = await this.buildImageContentPart(url)
        imageParts.push(part)
      } catch (error) {
        this.logger.error(
          'provider=%s event=download_failed url=%s error=%s',
          this.name,
          truncate(url, 80),
          JSON.stringify(sanitizeError(error)).slice(0, 200)
        )
        // 与 v1 一致：跳过失败图片，继续后续生成
      }
    }

    const apiBase = this.apiBase ?? DEFAULT_API_BASE
    const endpoint = `${apiBase}${CHAT_COMPLETIONS_PATH}`

    const allImages: string[] = []

    for (let i = 0; i < numImages; i++) {
      const contentParts: Array<unknown> = [{ type: 'text', text: prompt }, ...imageParts]
      const requestData = {
        model: this.modelId,
        stream: false,
        messages: [{ role: 'user', content: contentParts }],
      }

      this.logger.debug(
        'provider=%s event=generate_request current=%d total=%d endpoint=%s body_kb=%d',
        this.name,
        i + 1,
        numImages,
        endpoint,
        Math.round(JSON.stringify(requestData).length / 102.4) / 10
      )

      try {
        const response = await this.callApi<unknown>(() =>
          (
            this.ctx.http as unknown as {
              post: (
                url: string,
                body: unknown,
                opts: Record<string, unknown>
              ) => Promise<unknown>
            }
          ).post(endpoint, requestData, {
            headers: this.buildHeaders(),
            timeout: this.getTimeoutMs(),
          })
        )

        // 检查响应中是否携带错误（即使 HTTP 200）
        ensureNoEmbeddedError(response, this.name)

        const images = parseGptGodResponse(response, this.name, this.logger)

        if (images.length === 0) {
          // 如果响应里 choices 有内容文本但没图，认为是软错误
          const fallbackText = extractFirstChoiceText(response)
          if (fallbackText && !/https?:\/\//.test(fallbackText)) {
            const short = truncate(sanitizeString(fallbackText), 80)
            throw new ParseError(`生成失败：${short}`, { providerName: this.name })
          }
          this.logger.warn(
            'provider=%s event=empty_response current=%d total=%d',
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

        this.logger.info(
          'provider=%s event=generate_success current=%d total=%d images=%d',
          this.name,
          i + 1,
          numImages,
          images.length
        )
      } catch (error) {
        const normalized = error instanceof ProviderError ? error : this.handleProviderError(error)

        if (allImages.length > 0 && normalized.retryable === false) {
          this.logger.warn(
            'provider=%s event=partial_failed generated=%d requested=%d code=%s',
            this.name,
            allImages.length,
            numImages,
            normalized.code
          )
          break
        }
        throw normalized
      }
    }

    if (allImages.length === 0) {
      throw new ParseError('未能从 GPTGod API 生成图片，请检查 prompt 和模型配置', {
        providerName: this.name,
      })
    }

    return allImages
  }

  /**
   * 把任意来源的图片 URL 转为 chat completions 的 image_url 内容 part。
   *
   * - http(s):// 远程 URL：直接传递（gptgod 内部下载）
   * - data:image/...;base64,...：直接传递
   * - 其他（本地、koishi 资源）：下载后转 base64 内嵌
   */
  private async buildImageContentPart(
    url: string
  ): Promise<{ type: 'image_url'; image_url: { url: string } }> {
    if (!url) {
      throw new BadRequestError('下载图片失败，请检查图片链接是否有效', { providerName: this.name })
    }

    if (DATA_URL_REGEX.test(url) || HTTP_URL_REGEX.test(url)) {
      return { type: 'image_url', image_url: { url } }
    }

    const { data, mimeType } = await downloadImageAsBase64(
      this.ctx,
      url,
      this.apiTimeoutSeconds,
      this.logger
    )
    return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } }
  }

  /**
   * 子类专属错误归一化：把 PROHIBITED_CONTENT 等显式映射成 ContentFilterError。
   */
  protected override handleProviderError(error: unknown): ProviderError {
    const normalized = super.handleProviderError(error)
    const message = normalized.message ?? ''
    if (CONTENT_FILTER_KEYWORDS.some((kw) => message.includes(kw))) {
      return new ContentFilterError(message || '内容被安全策略拦截', {
        providerName: this.name,
        statusCode: normalized.statusCode,
        cause: normalized.cause,
      })
    }
    return normalized
  }
}

const CONTENT_FILTER_KEYWORDS = [
  'PROHIBITED_CONTENT',
  'blocked by Google Gemini',
  'prohibited under official usage policies',
  '内容被安全策略拦截',
]

// -------- 模块级解析逻辑 --------

/**
 * 解析 GPTGod 响应，提取图片 URL 数组。
 *
 * 兼容 v1 中观察到的所有响应形态：
 * - response.images / response.image
 * - response.choices[0].message.content（字符串 / 数组 / 含 image_url 字段）
 * - response.data / response.result
 * - 内嵌 markdown ![](url) 或 data:image/... 的纯文本
 */
function parseGptGodResponse(
  rawResponse: unknown,
  providerName: string,
  logger: { debug: Function; warn: Function; error: Function; info?: Function }
): string[] {
  const response = (rawResponse ?? {}) as Record<string, any>
  const images: string[] = []

  // 1. 顶层 images 数组
  if (Array.isArray(response.images)) {
    return response.images.filter((u: unknown) => typeof u === 'string') as string[]
  }

  // 2. 顶层 image 字段
  if (typeof response.image === 'string' && (response.image.startsWith('data:') || response.image.startsWith('http'))) {
    return [response.image]
  }

  // 3. choices[0].message.content
  const firstChoice = Array.isArray(response.choices) && response.choices.length > 0 ? response.choices[0] : null
  if (firstChoice) {
    const messageContent = firstChoice.message?.content
    let contentText = ''

    if (typeof messageContent === 'string') {
      contentText = messageContent
    } else if (Array.isArray(messageContent)) {
      for (const part of messageContent) {
        if (part?.type === 'image_url' && part?.image_url?.url) {
          images.push(part.image_url.url)
        } else if (typeof part?.text === 'string') {
          contentText += part.text + '\n'
        }
      }
    } else if (typeof messageContent?.text === 'string') {
      contentText = messageContent.text
    }

    if (images.length === 0 && contentText) {
      // markdown ![](url)
      const mdImageRegex = /!\[.*?\]\((https?:\/\/[^)]+)\)/g
      let m: RegExpExecArray | null
      while ((m = mdImageRegex.exec(contentText)) !== null) {
        if (m[1]) images.push(m[1])
      }
      // bare URL
      if (images.length === 0) {
        const urlRegex = /(https?:\/\/[^\s"')<>]+\.(?:png|jpg|jpeg|webp|gif|bmp))/gi
        let um: RegExpExecArray | null
        while ((um = urlRegex.exec(contentText)) !== null) {
          if (um[1]) images.push(um[1])
        }
      }
      // data: URL
      const dataUrlRegex = /(data:image\/[^;]+;base64,[^\s"')<>]+)/gi
      let dm: RegExpExecArray | null
      while ((dm = dataUrlRegex.exec(contentText)) !== null) {
        if (dm[1]) images.push(dm[1])
      }
    }

    // message 上其他字段
    if (images.length === 0 && firstChoice.message) {
      if (typeof firstChoice.message.image_url === 'string') {
        images.push(firstChoice.message.image_url)
      }
      if (Array.isArray(firstChoice.message.images)) {
        return firstChoice.message.images.filter((u: unknown) => typeof u === 'string') as string[]
      }
    }
  }

  // 4. 顶层 data / result
  if (images.length === 0 && response.data) {
    if (Array.isArray(response.data)) {
      for (const item of response.data) {
        if (typeof item === 'string') images.push(item)
        else if (typeof item?.url === 'string') images.push(item.url)
        else if (typeof item?.image_url === 'string') images.push(item.image_url)
        else if (typeof item?.b64_json === 'string') images.push(`data:image/jpeg;base64,${item.b64_json}`)
      }
    } else if (typeof response.data?.url === 'string') {
      images.push(response.data.url)
    }
  }

  if (images.length === 0 && response.result) {
    if (Array.isArray(response.result)) {
      for (const item of response.result) {
        if (typeof item === 'string') images.push(item)
        else if (typeof item?.url === 'string') images.push(item.url)
      }
    } else if (typeof response.result === 'string') {
      images.push(response.result)
    }
  }

  if (images.length === 0) {
    logger.warn(
      'provider=%s event=parse_no_image keys=%s',
      providerName,
      Object.keys(response).join(',')
    )
  }

  return images
}

/**
 * 抽出 choices[0].message.content 的纯文本（用于错误消息构造）
 */
function extractFirstChoiceText(rawResponse: unknown): string {
  const response = (rawResponse ?? {}) as Record<string, any>
  const choice = Array.isArray(response.choices) && response.choices.length > 0 ? response.choices[0] : null
  if (!choice) return ''
  const c = choice.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .filter((p: any) => typeof p?.text === 'string')
      .map((p: any) => p.text)
      .join(' ')
  }
  if (typeof c?.text === 'string') return c.text
  return ''
}

/**
 * 检查 200 响应里是否实际是错误（GPTGod 在 content 里夹带错误文本）
 */
function ensureNoEmbeddedError(rawResponse: unknown, providerName: string): void {
  const text = extractFirstChoiceText(rawResponse)
  if (!text) return

  if (CONTENT_FILTER_KEYWORDS.some((kw) => text.includes(kw)) || /content is prohibited/i.test(text)) {
    throw new ContentFilterError(`内容被安全策略拦截：${truncate(sanitizeString(text), 80)}`, {
      providerName,
    })
  }

  // 限流提示文本
  if (/rate limit|too many requests|过于频繁/i.test(text)) {
    throw new RateLimitError(`请求过于频繁：${truncate(sanitizeString(text), 80)}`, {
      providerName,
    })
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}

/**
 * 工厂函数（注册表用）
 */
export function createGptGodProvider(
  ctx: Context,
  config: Record<string, unknown>
): GptGodProvider {
  return new GptGodProvider({
    ctx,
    apiKey: String(config.apiKey ?? ''),
    modelId: String(config.modelId ?? ''),
    apiBase: typeof config.apiBase === 'string' ? config.apiBase : undefined,
    apiTimeout: Number.isFinite(config.apiTimeout as number) ? Number(config.apiTimeout) : 60,
    logLevel: config.logLevel as BaseProviderOptions['logLevel'],
    loggerName: 'aka-ai-image-generator:gptgod',
  })
}
