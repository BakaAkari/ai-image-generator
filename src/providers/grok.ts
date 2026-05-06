import type { Context } from 'koishi'

import { BaseImageProvider } from './base.js'
import {
  BadRequestError,
  ParseError,
  ProviderError,
} from './errors.js'
import type {
  BaseProviderOptions,
  ImageGeneratedCallback,
  ImageGenerationOptions,
} from './types.js'
import { downloadImageAsBase64, sanitizeError, sanitizeString } from './utils.js'

/**
 * GrokProvider 配置
 *
 * 复用 BaseProviderOptions 全部字段。
 */
export type GrokProviderOptions = BaseProviderOptions

/**
 * Grok 图像 API 默认 base（云雾中转）
 */
const DEFAULT_API_BASE = 'https://yunwu.ai'

/**
 * Grok creation 端点支持的固定尺寸映射（aspectRatio → size）
 *
 * Grok creation 端点仅接受：960x960 / 720x1280 / 1280x720 / 1168x784 / 784x1168
 */
const ASPECT_RATIO_SIZE_MAP: Record<string, string> = {
  '1:1': '960x960',
  '16:9': '1280x720',
  '9:16': '720x1280',
  '3:2': '1168x784',
  '2:3': '784x1168',
  '4:3': '1168x784',
}

const DEFAULT_CREATION_SIZE = '960x960'

const EDIT_VALID_RATIOS = new Set([
  '1:1',
  '3:4',
  '4:3',
  '9:16',
  '16:9',
  '2:3',
  '3:2',
  '9:19.5',
  '19.5:9',
  '9:20',
  '20:9',
  '1:2',
  '2:1',
  'auto',
])

interface GrokImagesResponse {
  error?: { message?: string; code?: string | number }
  data?: Array<{ url?: string; b64_json?: string }>
}

/**
 * GrokProvider（v2 重写版）
 *
 * 双模式：
 * - 文生图：POST {apiBase}/v1/images/generations
 * - 图生图：POST {apiBase}/v1/images/edits（multipart/form-data）
 *
 * 与 OpenAI Images API 同结构响应（data[].url / data[].b64_json）。
 */
export class GrokProvider extends BaseImageProvider {
  override readonly name = 'grok'

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
      'provider=%s event=generate_start has_input=%s input_count=%d num=%d model=%s aspect=%s resolution=%s',
      this.name,
      hasInputImages,
      validUrls.length,
      numImages,
      this.modelId,
      options?.aspectRatio ?? '-',
      options?.resolution ?? '-'
    )

    if (hasInputImages) {
      return this.editImages(prompt, validUrls, numImages, options, onImageGenerated)
    }
    return this.createImages(prompt, numImages, options, onImageGenerated)
  }

  /**
   * 文生图：POST /v1/images/generations
   */
  private async createImages(
    prompt: string,
    numImages: number,
    options?: ImageGenerationOptions,
    onImageGenerated?: ImageGeneratedCallback
  ): Promise<string[]> {
    const apiBase = this.apiBase ?? DEFAULT_API_BASE
    const endpoint = `${apiBase}/v1/images/generations`

    const size = this.getCreateSize(options)

    if (options?.resolution && ['1k', '2k', '4k'].includes(options.resolution)) {
      this.logger.info(
        'provider=%s event=preset_resolution_unsupported_for_create resolution=%s note=use_edit_endpoint_or_gemini',
        this.name,
        options.resolution
      )
    }

    const allImages: string[] = []

    for (let i = 0; i < numImages; i++) {
      const requestData: Record<string, unknown> = {
        model: this.modelId,
        prompt,
        size,
      }

      this.logger.debug(
        'provider=%s event=create_request current=%d total=%d size=%s',
        this.name,
        i + 1,
        numImages,
        size
      )

      try {
        const response = await this.callApi<GrokImagesResponse>(() =>
          (
            this.ctx.http as unknown as {
              post: (
                url: string,
                body: unknown,
                opts: Record<string, unknown>
              ) => Promise<GrokImagesResponse>
            }
          ).post(endpoint, requestData, {
            headers: this.buildHeaders(),
            timeout: this.getTimeoutMs(),
          })
        )

        const images = parseGrokResponse(response, this.name)

        if (images.length === 0) {
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
          'provider=%s event=create_success current=%d total=%d images=%d',
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
      throw new ParseError('未能从 Grok createImages 生成图片', { providerName: this.name })
    }

    return allImages
  }

  /**
   * 图生图：POST /v1/images/edits（multipart/form-data）
   *
   * Grok edit 仅支持单张输入图。
   */
  private async editImages(
    prompt: string,
    imageUrls: string[],
    numImages: number,
    options?: ImageGenerationOptions,
    onImageGenerated?: ImageGeneratedCallback
  ): Promise<string[]> {
    const apiBase = this.apiBase ?? DEFAULT_API_BASE
    const endpoint = `${apiBase}/v1/images/edits`

    const targetUrl = imageUrls[0]
    if (!targetUrl) {
      throw new BadRequestError('Grok edit 端点需要至少一张输入图', { providerName: this.name })
    }

    let inputBlob: Blob
    try {
      const { data, mimeType } = await downloadImageAsBase64(
        this.ctx,
        targetUrl,
        this.apiTimeoutSeconds,
        this.logger
      )
      inputBlob = base64ToBlob(data, mimeType)
    } catch (error) {
      this.logger.error(
        'provider=%s event=download_failed url=%s error=%s',
        this.name,
        truncate(targetUrl, 80),
        JSON.stringify(sanitizeError(error)).slice(0, 200)
      )
      throw new BadRequestError('下载输入图失败，无法执行 Grok 图像编辑', {
        providerName: this.name,
      })
    }

    const editAspectRatio = this.getEditAspectRatio(options?.aspectRatio)
    const editResolution = this.getEditResolution(options?.resolution)

    const allImages: string[] = []

    for (let i = 0; i < numImages; i++) {
      const formData = new FormData()
      formData.append('image', inputBlob, 'image_0.png')
      formData.append('prompt', prompt)
      formData.append('model', this.modelId)
      formData.append('n', '1')
      if (editAspectRatio) formData.append('aspect_ratio', editAspectRatio)
      if (editResolution) formData.append('resolution', editResolution)

      this.logger.debug(
        'provider=%s event=edit_request current=%d total=%d aspect=%s resolution=%s',
        this.name,
        i + 1,
        numImages,
        editAspectRatio ?? '-',
        editResolution ?? '-'
      )

      try {
        const response = await this.callApi<GrokImagesResponse>(() =>
          (
            this.ctx.http as unknown as {
              post: (
                url: string,
                body: unknown,
                opts: Record<string, unknown>
              ) => Promise<GrokImagesResponse>
            }
          ).post(endpoint, formData, {
            headers: { Authorization: `Bearer ${this.apiKey}` },
            timeout: this.getTimeoutMs(),
          })
        )

        const images = parseGrokResponse(response, this.name)

        if (images.length === 0) {
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
          'provider=%s event=edit_success current=%d total=%d images=%d',
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
      throw new ParseError('未能从 Grok editImages 生成图片', { providerName: this.name })
    }

    return allImages
  }

  // -------- 参数映射 --------

  private isCustomResolution(resolution?: string): boolean {
    return !!resolution && /^\d+x\d+$/.test(resolution)
  }

  private getSizeFromAspectRatio(aspectRatio?: string): string {
    return ASPECT_RATIO_SIZE_MAP[aspectRatio ?? '1:1'] ?? DEFAULT_CREATION_SIZE
  }

  private getCreateSize(options?: ImageGenerationOptions): string {
    if (options?.resolution && this.isCustomResolution(options.resolution)) {
      return options.resolution
    }
    return this.getSizeFromAspectRatio(options?.aspectRatio)
  }

  private getEditAspectRatio(aspectRatio?: string): string | undefined {
    if (!aspectRatio) return undefined
    return EDIT_VALID_RATIOS.has(aspectRatio) ? aspectRatio : undefined
  }

  private getEditResolution(resolution?: string): string | undefined {
    if (resolution === '1k' || resolution === '2k') return resolution
    return undefined
  }
}

// -------- 模块级工具 --------

/**
 * 解析 Grok 响应（与 OpenAI Images API 同构）
 *
 * - response.data[].b64_json → data:image/jpeg;base64,...
 * - response.data[].url → 直接使用
 */
function parseGrokResponse(response: GrokImagesResponse | undefined, providerName: string): string[] {
  if (!response) {
    throw new ParseError('Grok API 响应为空', { providerName })
  }

  if (response.error) {
    const message = sanitizeString(response.error.message ?? JSON.stringify(sanitizeError(response.error)))
    throw new ProviderError('UNKNOWN', `Grok API 错误: ${message}`, { providerName })
  }

  const images: string[] = []
  if (Array.isArray(response.data)) {
    for (const item of response.data) {
      if (item.b64_json) {
        images.push(`data:image/jpeg;base64,${item.b64_json}`)
      } else if (item.url) {
        images.push(item.url)
      }
    }
  }

  return images
}

function base64ToBlob(base64Data: string, mimeType: string): Blob {
  const byteCharacters = atob(base64Data)
  const byteNumbers = new Array<number>(byteCharacters.length)
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
 * 工厂函数（注册表用）
 */
export function createGrokProvider(
  ctx: Context,
  config: Record<string, unknown>
): GrokProvider {
  return new GrokProvider({
    ctx,
    apiKey: String(config.apiKey ?? ''),
    modelId: String(config.modelId ?? ''),
    apiBase: typeof config.apiBase === 'string' ? config.apiBase : undefined,
    apiTimeout: Number.isFinite(config.apiTimeout as number) ? Number(config.apiTimeout) : 60,
    logLevel: config.logLevel as BaseProviderOptions['logLevel'],
    loggerName: 'aka-ai-image-generator:grok',
  })
}
