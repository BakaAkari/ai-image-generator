import type { Context } from 'koishi'

import { BaseImageProvider } from './base.js'
import { ContentFilterError, ParseError, ProviderError } from './errors.js'
import type {
  BaseProviderOptions,
  ImageGeneratedCallback,
  ImageGenerationOptions,
} from './types.js'
import { downloadImageAsBase64, sanitizeError, sanitizeString } from './utils.js'

/**
 * OpenAI Provider 配置
 *
 * 复用 BaseProviderOptions 的全部字段，无需额外字段。
 */
export type OpenAIProviderOptions = BaseProviderOptions

/**
 * GPT Image 模型最低超时（秒）。
 *
 * gpt-image-1 / gpt-image-2 等模型生成复杂图像通常需要 60-180+ 秒，
 * 因此即使用户配置了较短的 apiTimeout，也至少保证此下限。
 */
const GPT_IMAGE_MIN_TIMEOUT_SECONDS = 180

/**
 * OpenAI Images API 默认 base。
 *
 * 服务层通常会显式传入 apiBase；此处保留官方 OpenAI 默认值作为 Provider 独立使用时的兜底。
 */
const DEFAULT_API_BASE = 'https://api.openai.com/v1'

/**
 * 宽高比 → 尺寸映射（OpenAI Images 仅支持固定 size 字符串）
 */
const ASPECT_RATIO_SIZE_MAP: Record<string, string> = {
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
  '16:9': '2048x1152',
  '9:16': '1152x2048',
  '4:3': '1536x1024',
}

interface OpenAIImagesResponse {
  error?: { message?: string; type?: string; code?: string }
  data?: Array<{
    b64_json?: string
    url?: string
    revised_prompt?: string
  }>
}

/**
 * OpenAIProvider（v2 重写版）
 *
 * 相比 v1：
 * - 继承 BaseImageProvider，复用 callApi / handleProviderError / 流式回调封装
 * - 错误统一归一化为 ProviderError 子类
 * - 不再持有 ProviderConfig；apiKey/modelId/apiBase/apiTimeout 全部由基类管理
 * - 仍保留 v1 关键能力：JSON+base64 优先 + FormData 回退、自定义分辨率、GPT Image 超时下限提升
 */
export class OpenAIProvider extends BaseImageProvider {
  override readonly name: string = 'openai'

  /** GPT Image 模型对超时的下限保护（秒） */
  private getEffectiveTimeoutSeconds(): number {
    const configured = this.apiTimeoutSeconds
    const modelId = this.modelId.toLowerCase()
    if (modelId.startsWith('gpt-image')) {
      const effective = Math.max(configured, GPT_IMAGE_MIN_TIMEOUT_SECONDS)
      if (effective !== configured) {
        this.logger.info(
          'provider=%s event=timeout_promoted configured=%d effective=%d model=%s',
          this.name,
          configured,
          effective,
          this.modelId
        )
      }
      return effective
    }
    return configured
  }

  protected override getTimeoutMs(): number {
    return Math.max(0, this.getEffectiveTimeoutSeconds() * 1000)
  }

  override async generateImages(
    prompt: string,
    imageUrls: string | string[],
    numImages: number,
    options?: ImageGenerationOptions,
    onImageGenerated?: ImageGeneratedCallback
  ): Promise<string[]> {
    const urls = Array.isArray(imageUrls) ? imageUrls : [imageUrls]
    const validUrls = urls.filter((url) => url && typeof url === 'string' && url.trim().length > 0)
    const hasInputImages = validUrls.length > 0

    if (this.shouldLogDetail()) {
      this.logger.info(
        'provider=%s event=generate_detail has_input=%s input_count=%d num=%d model=%s api_base=%s timeout_ms=%d auth=%s extra_headers=%s',
        this.name,
        hasInputImages,
        validUrls.length,
        numImages,
        this.modelId,
        this.getApiBase(),
        this.getTimeoutMs(),
        this.apiKey ? 'configured' : 'missing',
        JSON.stringify(redactHeaders(this.extraHeaders)),
      )
    }

    try {
      if (hasInputImages) {
        return await this.editImages(prompt, validUrls, numImages, options, onImageGenerated)
      }
      return await this.createImages(prompt, numImages, options, onImageGenerated)
    } catch (error) {
      const normalized = error instanceof ProviderError ? error : this.handleProviderError(error)
      this.logger.error(
        'provider=%s event=generate_failed code=%s status=%s retryable=%s message=%s context=%s',
        this.name,
        normalized.code,
        normalized.statusCode ?? '-',
        normalized.retryable,
        normalized.message,
        JSON.stringify(normalized.context),
      )
      throw normalized
    }
  }

  // -------- internal: size 解析 --------

  private isCustomResolution(resolution?: string): boolean {
    return typeof resolution === 'string' && /^\d+x\d+$/.test(resolution)
  }

  private getSize(options?: ImageGenerationOptions): string {
    if (options?.resolution && this.isCustomResolution(options.resolution)) {
      return options.resolution
    }
    return ASPECT_RATIO_SIZE_MAP[options?.aspectRatio ?? '1:1'] ?? '1024x1024'
  }

  private getApiBase(): string {
    return normalizeV1Base(this.apiBase ?? DEFAULT_API_BASE)
  }

  // -------- 文生图 --------

  private async createImages(
    prompt: string,
    numImages: number,
    options?: ImageGenerationOptions,
    onImageGenerated?: ImageGeneratedCallback
  ): Promise<string[]> {
    const apiBase = this.getApiBase()
    const size = this.getSize(options)

    if (options?.resolution && ['1k', '2k', '4k'].includes(options.resolution)) {
      this.logger.info(
        'provider=%s event=resolution_preset_ignored resolution=%s note=use_gemini_or_custom_size',
        this.name,
        options.resolution
      )
    }

    const allImages: string[] = []

    for (let i = 0; i < numImages; i++) {
      const requestData = {
        model: this.modelId,
        prompt,
        n: 1,
        size,
      }

      if (this.shouldLogDetail()) {
        this.logger.info(
          'provider=%s event=create_detail current=%d total=%d url=%s model=%s size=%s timeout_ms=%d request=%s headers=%s',
          this.name,
          i + 1,
          numImages,
          `${apiBase}/images/generations`,
          this.modelId,
          size,
          this.getTimeoutMs(),
          JSON.stringify(redactRequestBody(requestData)),
          JSON.stringify(redactHeaders(this.buildHeaders())),
        )
      }

      try {
        const response = await this.callApi<OpenAIImagesResponse>(() =>
          (this.ctx.http as unknown as {
            post: (url: string, body: unknown, opts: Record<string, unknown>) => Promise<OpenAIImagesResponse>
          }).post(`${apiBase}/images/generations`, requestData, {
            headers: this.buildHeaders(),
            timeout: this.getTimeoutMs(),
          })
        )

        const images = parseOpenAIImagesResponse(response)
        if (images.length === 0) {
          this.logger.warn(
            'provider=%s event=create_empty_response current=%d total=%d',
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
          'provider=%s event=create_success current=%d total=%d',
          this.name,
          i + 1,
          numImages
        )
      } catch (error) {
        const normalized = error instanceof ProviderError ? error : this.handleProviderError(error)

        // 已生成部分图片：返回已成功部分（保留 v1 行为）
        if (allImages.length > 0 && normalized.retryable === false) {
          this.logger.warn(
            'provider=%s event=create_partial_failed generated=%d requested=%d code=%s',
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
      throw new ParseError('未能生成任何图片', { providerName: this.name })
    }
    return allImages
  }

  // -------- 图生图（编辑） --------

  private async editImages(
    prompt: string,
    imageUrls: string[],
    numImages: number,
    options?: ImageGenerationOptions,
    onImageGenerated?: ImageGeneratedCallback
  ): Promise<string[]> {
    const apiBase = this.getApiBase()
    const size = this.getSize(options)

    if (this.shouldLogDetail()) {
      this.logger.info(
        'provider=%s event=edit_download_detail count=%d size=%s',
        this.name,
        imageUrls.length,
        size
      )
    }

    const imageDataList: Array<{ data: string; mimeType: string }> = []
    for (const url of imageUrls) {
      try {
        const result = await downloadImageAsBase64(this.ctx, url, this.apiTimeoutSeconds, this.logger)
        imageDataList.push(result)
      } catch (error) {
        this.logger.error(
          'provider=%s event=download_failed url=%s error=%s',
          this.name,
          truncate(url, 80),
          JSON.stringify(sanitizeError(error)).slice(0, 200)
        )
      }
    }

    if (imageDataList.length === 0) {
      throw new ParseError('所有输入图片下载失败，无法进行图像编辑', {
        providerName: this.name,
      })
    }

    const allImages: string[] = []

    for (let i = 0; i < numImages; i++) {
      if (this.shouldLogDetail()) {
        this.logger.info(
          'provider=%s event=edit_detail current=%d total=%d url=%s model=%s size=%s input_count=%d timeout_ms=%d headers=%s',
          this.name,
          i + 1,
          numImages,
          `${apiBase}/images/edits`,
          this.modelId,
          size,
          imageDataList.length,
          this.getTimeoutMs(),
          JSON.stringify(redactHeaders(this.buildHeaders())),
        )
      }

      try {
        const response = await this.callApi<OpenAIImagesResponse>(() =>
          this.callEditApi(apiBase, prompt, size, imageDataList)
        )

        const images = parseOpenAIImagesResponse(response)
        if (images.length === 0) {
          this.logger.warn(
            'provider=%s event=edit_empty_response current=%d total=%d',
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
          'provider=%s event=edit_success current=%d total=%d',
          this.name,
          i + 1,
          numImages
        )
      } catch (error) {
        const normalized = error instanceof ProviderError ? error : this.handleProviderError(error)
        if (allImages.length > 0 && normalized.retryable === false) {
          this.logger.warn(
            'provider=%s event=edit_partial_failed generated=%d requested=%d code=%s',
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
      throw new ParseError('未能生成任何图片', { providerName: this.name })
    }
    return allImages
  }

  /**
   * 实际调用 /v1/images/edits：JSON + base64 优先，失败回退到 FormData multipart。
   */
  private async callEditApi(
    apiBase: string,
    prompt: string,
    size: string,
    imageDataList: Array<{ data: string; mimeType: string }>
  ): Promise<OpenAIImagesResponse> {
    const editUrl = `${apiBase}/images/edits`
    const http = this.ctx.http as unknown as {
      post: (url: string, body: unknown, opts: Record<string, unknown>) => Promise<OpenAIImagesResponse>
    }

    // 1) JSON + base64
    try {
      const imageInputs = imageDataList.map((img) => `data:${img.mimeType};base64,${img.data}`)
      const requestData: Record<string, unknown> = {
        model: this.modelId,
        prompt,
        n: 1,
        size,
        image: imageInputs.length === 1 ? imageInputs[0] : imageInputs,
      }
      if (this.shouldLogDetail()) {
        this.logger.info(
          'provider=%s event=edit_json_detail url=%s request=%s headers=%s',
          this.name,
          editUrl,
          JSON.stringify(redactRequestBody(requestData)),
          JSON.stringify(redactHeaders(this.buildHeaders())),
        )
      }
      return await http.post(editUrl, requestData, {
        headers: this.buildHeaders(),
        timeout: this.getTimeoutMs(),
      })
    } catch (jsonError) {
      // 2) FormData 回退
      this.logger.warn(
        'provider=%s event=edit_json_failed fallback=formdata error=%s',
        this.name,
        sanitizeString((jsonError as Error)?.message || '未知错误')
      )

      const formData = new FormData()
      for (let idx = 0; idx < imageDataList.length; idx++) {
        const img = imageDataList[idx]!
        const blob = base64ToBlob(img.data, img.mimeType)
        formData.append('image', blob, `image_${idx}.png`)
      }
      formData.append('prompt', prompt)
      formData.append('model', this.modelId)
      formData.append('n', '1')
      formData.append('size', size)

      if (this.shouldLogDetail()) {
        this.logger.info(
          'provider=%s event=edit_formdata_detail url=%s model=%s size=%s image_count=%d headers=%s',
          this.name,
          editUrl,
          this.modelId,
          size,
          imageDataList.length,
          JSON.stringify(redactHeaders({ Authorization: `Bearer ${this.apiKey}` })),
        )
      }
      return await http.post(editUrl, formData, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        timeout: this.getTimeoutMs(),
      })
    }
  }
}

// -------- 模块级工具 --------

function parseOpenAIImagesResponse(response: OpenAIImagesResponse | undefined): string[] {
  if (!response) {
    throw new ParseError('OpenAI Images API 响应为空', { providerName: 'openai' })
  }

  if (response.error) {
    const errMessage = sanitizeString(response.error.message ?? JSON.stringify(sanitizeError(response.error)))
    if (isContentFilter(errMessage)) {
      throw new ContentFilterError(errMessage, { providerName: 'openai' })
    }
    throw new ProviderError('UNKNOWN', `OpenAI Images API 错误: ${errMessage}`, {
      providerName: 'openai',
    })
  }

  const data = response.data
  if (!Array.isArray(data)) return []

  const images: string[] = []
  for (const item of data) {
    if (item.b64_json) {
      const mimeType = 'image/png'
      images.push(`data:${mimeType};base64,${item.b64_json}`)
    } else if (item.url) {
      images.push(item.url)
    }
  }
  return images
}

function isContentFilter(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('safety system') ||
    lower.includes('content_policy_violation') ||
    lower.includes('content policy') ||
    lower.includes('inappropriate') ||
    lower.includes('违规') ||
    lower.includes('内容审核')
  )
}

function base64ToBlob(base64Data: string, mimeType: string): Blob {
  const byteCharacters = atob(base64Data)
  const byteNumbers = new Array(byteCharacters.length)
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i)
  }
  const byteArray = new Uint8Array(byteNumbers)
  return new Blob([byteArray], { type: mimeType })
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (lower === 'authorization' || lower.includes('api-key') || lower.includes('apikey') || lower.includes('token') || lower.includes('secret')) {
      result[key] = value ? '[REDACTED]' : ''
    } else {
      result[key] = truncate(value, 120)
    }
  }
  return result
}

function redactRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (key === 'prompt' && typeof value === 'string') {
      result.promptLength = value.length
    } else if (key === 'image') {
      result.image = describeImagePayload(value)
    } else {
      result[key] = value
    }
  }
  return result
}

function describeImagePayload(value: unknown): unknown {
  if (typeof value === 'string') return describeImageString(value)
  if (Array.isArray(value)) return value.map(describeImageString)
  return typeof value
}

function describeImageString(value: unknown): string {
  if (typeof value !== 'string') return typeof value
  if (value.startsWith('data:')) {
    const commaIndex = value.indexOf(',')
    const meta = commaIndex >= 0 ? value.slice(0, commaIndex) : 'data:*'
    return `${meta},[base64 length=${Math.max(0, value.length - commaIndex - 1)}]`
  }
  return truncate(value, 120)
}

/**
 * 工厂函数（注册表用）。
 *
 * 期望 config 结构：
 * ```ts
 * {
 *   apiKey: string
 *   modelId: string
 *   apiBase?: string
 *   apiTimeout: number
 * }
 * ```
 */
export function createOpenAIProvider(
  ctx: Context,
  config: Record<string, unknown>
): OpenAIProvider {
  return new OpenAIProvider({
    ctx,
    apiKey: String(config.apiKey ?? ''),
    modelId: String(config.modelId ?? ''),
    apiBase: typeof config.apiBase === 'string' ? config.apiBase : undefined,
    apiTimeout: Number.isFinite(config.apiTimeout as number)
      ? Number(config.apiTimeout)
      : 60,
    logLevel: config.logLevel as BaseProviderOptions['logLevel'],
    loggerName: 'aka-ai-image-generator:openai',
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
