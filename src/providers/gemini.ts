import type { Context } from 'koishi'

import { BaseImageProvider } from './base.js'
import {
  BadRequestError,
  ContentFilterError,
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
 * GeminiProvider 配置
 *
 * 复用 BaseProviderOptions 的全部字段，无需额外字段。
 */
export type GeminiProviderOptions = BaseProviderOptions

/**
 * Gemini 默认 base（官方端点）
 */
const DEFAULT_API_BASE = 'https://generativelanguage.googleapis.com'

/**
 * resolution → Gemini 官方 imageConfig.imageSize 映射
 */
const RESOLUTION_IMAGE_SIZE_MAP: Record<string, string> = {
  '1k': 'LOW',
  '2k': 'MEDIUM',
  '4k': '4K',
}

/**
 * resolution → 云雾（yunwu）等第三方 Gemini 兼容端 imageConfig.imageSize 映射
 *
 * 云雾原生接口使用数值字符串：512 / 1K / 2K / 4K
 */
const YUNWU_RESOLUTION_IMAGE_SIZE_MAP: Record<string, string> = {
  '1k': '1K',
  '2k': '2K',
  '4k': '4K',
}

/**
 * GeminiProvider（v2 重写版）
 *
 * 端点：POST {apiBase}/v1beta/models/{modelId}:generateContent
 * 鉴权：URL params 携带 ?key=xxx（与官方一致）
 *
 * 关键能力：
 * - 兼容 Google Gemini 原生 generateContent 响应结构
 * - 仅在官方 Gemini API 或已知支持 imageConfig 的模型下发送 imageConfig
 * - 解析 inlineData / inline_data / fileData 三种结构
 * - 严格识别 promptFeedback.blockReason / candidate.finishReason 中的安全拦截
 */
export class GeminiProvider extends BaseImageProvider {
  override readonly name = 'gemini'

  override async generateImages(
    prompt: string,
    imageUrls: string | string[],
    numImages: number,
    options?: ImageGenerationOptions,
    onImageGenerated?: ImageGeneratedCallback
  ): Promise<string[]> {
    const urls = Array.isArray(imageUrls) ? imageUrls : [imageUrls]
    const validUrls = urls.filter((url) => url && typeof url === 'string' && url.trim().length > 0)

    this.logger.debug(
      'provider=%s event=generate_start has_input=%s input_count=%d num=%d model=%s',
      this.name,
      validUrls.length > 0,
      validUrls.length,
      numImages,
      this.modelId
    )

    // 下载所有输入图片并转换为 inline_data parts
    const imageParts: Array<{ inline_data: { mime_type: string; data: string } }> = []
    for (const url of validUrls) {
      try {
        const { data, mimeType } = await downloadImageAsBase64(
          this.ctx,
          url,
          this.apiTimeoutSeconds,
          this.logger
        )
        imageParts.push({ inline_data: { mime_type: mimeType, data } })
      } catch (error) {
        this.logger.error(
          'provider=%s event=download_failed url=%s error=%s',
          this.name,
          truncate(url, 80),
          JSON.stringify(sanitizeError(error)).slice(0, 200)
        )
        // 与 v1 行为一致：跳过失败图片，继续处理
      }
    }

    const apiBase = this.apiBase ?? DEFAULT_API_BASE
    const endpoint = `${apiBase}/v1beta/models/${this.modelId}:generateContent`
    const isOfficialGeminiApi = apiBase.includes('generativelanguage.googleapis.com')
    const supportsImageConfig = true

    const generationConfig = this.buildGenerationConfig(options, isOfficialGeminiApi)
    const safetySettings = buildSafetySettings()


    const allImages: string[] = []

    for (let i = 0; i < numImages; i++) {
      const requestData = {
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }, ...imageParts],
          },
        ],
        generationConfig,
        safetySettings,
      }

      this.logger.debug(
        'provider=%s event=generate_request current=%d total=%d endpoint=%s aspect=%s resolution=%s image_size=%s',
        this.name,
        i + 1,
        numImages,
        endpoint,
        options?.aspectRatio ?? '-',
        options?.resolution ?? '-',
        (generationConfig.imageConfig as { imageSize?: string } | undefined)?.imageSize ?? '-'
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
            headers: { 'Content-Type': 'application/json' },
            params: { key: this.apiKey },
            timeout: this.getTimeoutMs(),
          })
        )

        const images = parseGeminiResponse(response, this.name, this.logger)
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
      throw new ParseError('未能从 Gemini API 生成图片，请检查 prompt 和模型配置', {
        providerName: this.name,
      })
    }

    return allImages
  }

  /**
   * 构建 generationConfig。
   *
   * - 始终包含 responseModalities: ['TEXT', 'IMAGE']
   * - 在官方 Gemini API 和云雾等兼容端点均发送 imageConfig（现代模型已支持）
   * - 官方端点使用 LOW / MEDIUM / 4K；云雾等第三方使用 1K / 2K / 4K
   */
  private buildGenerationConfig(
    options: ImageGenerationOptions | undefined,
    isOfficialGeminiApi: boolean
  ): Record<string, unknown> {
    const generationConfig: Record<string, unknown> = {
      responseModalities: ['TEXT', 'IMAGE'],
    }

    const imageConfig: Record<string, unknown> = {}

    if (options?.aspectRatio) {
      imageConfig.aspectRatio = options.aspectRatio
    }

    if (options?.resolution) {
      const map = isOfficialGeminiApi
        ? RESOLUTION_IMAGE_SIZE_MAP
        : YUNWU_RESOLUTION_IMAGE_SIZE_MAP
      const mapped = map[options.resolution]
      if (mapped) {
        imageConfig.imageSize = mapped
      } else if (/^\d+x\d+$/.test(options.resolution)) {
        this.logger.info(
          'provider=%s event=custom_resolution_unsupported resolution=%s note=use_1k_2k_4k',
          this.name,
          options.resolution
        )
      }
    }

    if (Object.keys(imageConfig).length > 0) {
      generationConfig.imageConfig = imageConfig
    }
    return generationConfig
  }
}

// -------- 模块级工具 --------

/**
 * 解析 Gemini 响应
 *
 * 支持的图像数据结构（按优先级）：
 * - candidate.content.parts[].inlineData.data + mimeType（驼峰）
 * - candidate.content.parts[].inline_data.data + mime_type（下划线）
 * - candidate.content.parts[].fileData.fileUri
 *
 * 抛出：
 * - ContentFilterError：promptFeedback.blockReason='SAFETY'/'RECITATION' 或 finishReason 同
 * - BadRequestError：blockReason='OTHER' 等明确表示请求异常
 * - ParseError：响应结构异常
 */
function parseGeminiResponse(
  rawResponse: unknown,
  providerName: string,
  logger: { debug: Function; warn: Function; error: Function; info?: Function }
): string[] {
  const response = (rawResponse ?? {}) as {
    error?: { message?: string }
    promptFeedback?: {
      blockReason?: string
      blockReasonMessage?: string
      safetyRatings?: Array<{ category?: string; probability?: string }>
    }
    candidates?: Array<{
      finishReason?: string
      finishMessage?: string
      content?: {
        parts?: Array<{
          inlineData?: { data?: string; mimeType?: string }
          inline_data?: { data?: string; mime_type?: string }
          fileData?: { fileUri?: string }
          text?: string
        }>
      }
      safetyRatings?: unknown
    }>
  }

  if (!rawResponse || typeof rawResponse !== 'object') {
    throw new ParseError('Gemini API 响应为空或格式异常', { providerName })
  }

  if (response.error) {
    const safeMessage = sanitizeString(response.error.message ?? JSON.stringify(sanitizeError(response.error)))
    if (isContentFilterText(safeMessage)) {
      throw new ContentFilterError(safeMessage, { providerName })
    }
    throw new ProviderError('UNKNOWN', `Gemini API 错误: ${safeMessage}`, { providerName })
  }

  // promptFeedback：请求级阻断
  if (response.promptFeedback?.blockReason) {
    const reason = response.promptFeedback.blockReason
    const detail = response.promptFeedback.blockReasonMessage
    const ratings = (response.promptFeedback.safetyRatings ?? [])
      .map((r) => `${r.category ?? '?'}:${r.probability ?? '?'}`)
      .join(', ')

    if (reason === 'SAFETY' || reason === 'RECITATION') {
      const msg = `内容被安全策略阻止 (${reason})${detail ? `: ${detail}` : ''}${ratings ? ` [${ratings}]` : ''}`
      throw new ContentFilterError(msg, { providerName })
    }
    if (reason === 'OTHER') {
      const msg = `请求被阻止 (OTHER)${detail ? `: ${detail}` : ''}`
      throw new BadRequestError(msg, { providerName })
    }
    throw new BadRequestError(`请求被阻止 (${reason})${detail ? `: ${detail}` : ''}`, {
      providerName,
    })
  }

  if (!Array.isArray(response.candidates) || response.candidates.length === 0) {
    throw new ParseError('Gemini API 响应中没有 candidates 也没有 promptFeedback', {
      providerName,
    })
  }

  const images: string[] = []

  for (const candidate of response.candidates) {
    // finishReason 异常
    const finishReason = candidate.finishReason
    if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
      if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
        const msg = `内容被阻止: ${finishReason}${candidate.finishMessage ? ` (${candidate.finishMessage})` : ''}`
        throw new ContentFilterError(msg, { providerName })
      }
      // 其他异常 finishReason 且没有 parts 时报错；有 parts 则继续解析
      const hasParts = !!candidate.content?.parts && candidate.content.parts.length > 0
      if (!hasParts) {
        const msg = `生成失败: ${finishReason}${candidate.finishMessage ? `, ${candidate.finishMessage}` : ''}`
        logger.warn(
          'provider=%s event=finish_reason_anomaly reason=%s detail=%s',
          providerName,
          finishReason,
          candidate.finishMessage ?? '-'
        )
        throw new BadRequestError(msg, { providerName })
      }
    }

    const parts = candidate.content?.parts ?? []
    for (const part of parts) {
      if (part.inlineData?.data) {
        const mime = part.inlineData.mimeType ?? 'image/jpeg'
        images.push(`data:${mime};base64,${part.inlineData.data}`)
      } else if (part.inline_data?.data) {
        const mime = part.inline_data.mime_type ?? 'image/jpeg'
        images.push(`data:${mime};base64,${part.inline_data.data}`)
      } else if (part.fileData?.fileUri) {
        images.push(part.fileData.fileUri)
      } else if (part.text) {
        logger.warn(
          'provider=%s event=text_part_only text=%s',
          providerName,
          truncate(part.text, 100)
        )
      }
    }
  }

  return images
}

function isContentFilterText(message: string): boolean {
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

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}

/**
 * 构建 Gemini safetySettings —— 全部 4 类阈值设为 BLOCK_NONE，与 v1 行为一致。
 */
function buildSafetySettings(): Array<{ category: string; threshold: string }> {
  return [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
  ]
}

/**
 * 工厂函数（注册表用）
 */
export function createGeminiProvider(
  ctx: Context,
  config: Record<string, unknown>
): GeminiProvider {
  return new GeminiProvider({
    ctx,
    apiKey: String(config.apiKey ?? ''),
    modelId: String(config.modelId ?? ''),
    apiBase: typeof config.apiBase === 'string' ? config.apiBase : undefined,
    apiTimeout: Number.isFinite(config.apiTimeout as number) ? Number(config.apiTimeout) : 60,
    logLevel: config.logLevel as BaseProviderOptions['logLevel'],
    loggerName: 'aka-ai-image-generator:gemini',
  })
}
