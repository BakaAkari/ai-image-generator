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
 * OpenAI Images Provider 配置
 *
 * 复用 BaseProviderOptions 的全部字段，无需额外字段。
 */
export type OpenAIImagesProviderOptions = BaseProviderOptions

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
 * 与 v1 行为保持一致：默认指向 yunwu 兼容端点，可由配置覆盖。
 */
const DEFAULT_API_BASE = 'https://yunwu.ai'

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
 * OpenAIImagesProvider（v2 重写版）
 *
 * 相比 v1：
 * - 继承 BaseImageProvider，复用 callApi / handleProviderError / 流式回调封装
 * - 错误统一归一化为 ProviderError 子类
 * - 不再持有 ProviderConfig；apiKey/modelId/apiBase/apiTimeout 全部由基类管理
 * - 仍保留 v1 关键能力：JSON+base64 优先 + FormData 回退、自定义分辨率、GPT Image 超时下限提升
 */
export class OpenAIImagesProvider extends BaseImageProvider {
  override readonly name: string = 'openai-images'

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

    this.logger.debug(
      'provider=%s event=generate_start has_input=%s input_count=%d num=%d model=%s',
      this.name,
      hasInputImages,
      validUrls.length,
      numImages,
      this.modelId
    )

    try {
      if (hasInputImages) {
        return await this.editImages(prompt, validUrls, numImages, options, onImageGenerated)
      }
      return await this.createImages(prompt, numImages, options, onImageGenerated)
    } catch (error) {
      const normalized = error instanceof ProviderError ? error : this.handleProviderError(error)
      this.logger.error(
        'provider=%s event=generate_failed code=%s status=%s message=%s',
        this.name,
        normalized.code,
        normalized.statusCode ?? '-',
        normalized.message
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

      this.logger.debug(
        'provider=%s event=create_request current=%d total=%d model=%s size=%s',
        this.name,
        i + 1,
        numImages,
        this.modelId,
        size
      )

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

    this.logger.debug(
      'provider=%s event=edit_download_inputs count=%d size=%s',
      this.name,
      imageUrls.length,
      size
    )

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
      this.logger.debug(
        'provider=%s event=edit_request current=%d total=%d input_count=%d',
        this.name,
        i + 1,
        numImages,
        imageDataList.length
      )

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
    throw new ParseError('OpenAI Images API 响应为空', { providerName: 'openai-images' })
  }

  if (response.error) {
    const errMessage = sanitizeString(response.error.message ?? JSON.stringify(sanitizeError(response.error)))
    if (isContentFilter(errMessage)) {
      throw new ContentFilterError(errMessage, { providerName: 'openai-images' })
    }
    throw new ProviderError('UNKNOWN', `OpenAI Images API 错误: ${errMessage}`, {
      providerName: 'openai-images',
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
export function createOpenAIImagesProvider(
  ctx: Context,
  config: Record<string, unknown>
): OpenAIImagesProvider {
  return new OpenAIImagesProvider({
    ctx,
    apiKey: String(config.apiKey ?? ''),
    modelId: String(config.modelId ?? ''),
    apiBase: typeof config.apiBase === 'string' ? config.apiBase : undefined,
    apiTimeout: Number.isFinite(config.apiTimeout as number)
      ? Number(config.apiTimeout)
      : 60,
    logLevel: config.logLevel as BaseProviderOptions['logLevel'],
    loggerName: 'aka-ai-image-generator:openai-images',
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
