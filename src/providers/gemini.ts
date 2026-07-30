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
import type { ImageContract } from '../contracts/types.js'

export type GeminiProviderOptions = BaseProviderOptions

const DEFAULT_API_BASE = 'https://generativelanguage.googleapis.com'

/**
 * GeminiProvider（契约驱动版）。
 *
 * 契约决定：
 * - 是否发送 imageConfig（编辑契约通常不发）。
 * - imageSize 是否发送 + 大小写（云雾 3 Pro：1K/2K/4K；2.5 无 imageSize）。
 * - 是否附带 response_format=url（云雾扩展，官方契约禁用）。
 * - 是否发送 Authorization（未在契约层区分；沿用 apiKey 走 query 参数 `?key=`，
 *   Apifox 显示官方与云雾均支持）。
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
    const contract = options?.contract
    if (!contract) {
      throw new BadRequestError('Gemini 请求缺少精确契约，fail-closed', { providerName: this.name })
    }
    if (options?.rejectedParams && options.rejectedParams.length > 0) {
      const summary = options.rejectedParams
        .map((r) => `${r.key}｜${r.reason}`)
        .join('；')
      throw new BadRequestError(`参数不被当前契约接受（rejected）：${summary}`, {
        providerName: this.name,
      })
    }

    const urls = Array.isArray(imageUrls) ? imageUrls : [imageUrls]
    const validUrls = urls.filter((url) => url && typeof url === 'string' && url.trim().length > 0)
    const isEdit = contract.operation === 'image-edit' || contract.operation === 'image-to-image' || contract.operation === 'compose-image'

    if (this.shouldLogDetail()) {
      this.logger.info(
        'provider=%s event=generate_detail contract=%s operation=%s has_input=%s input_count=%d num=%d model=%s',
        this.name, contract.id, contract.operation, validUrls.length > 0, validUrls.length, numImages, this.modelId,
      )
    }

    // 编辑操作：契约声明要求参考图；全部下载失败 → 明确失败，不退化为文生图
    const imageParts: Array<{ inline_data: { mime_type: string; data: string } }> = []
    if (validUrls.length > 0) {
      let firstDownloadError: string | undefined
      for (const url of validUrls) {
        try {
          const { data, mimeType } = await downloadImageAsBase64(
            this.ctx,
            url,
            this.apiTimeoutSeconds,
            this.logger,
          )
          imageParts.push({ inline_data: { mime_type: mimeType, data } })
        } catch (error) {
          firstDownloadError ??= error instanceof Error ? error.message : String(error)
          this.logger.error(
            'provider=%s event=download_failed url=%s error=%s',
            this.name,
            truncate(url, 80),
            JSON.stringify(sanitizeError(error)).slice(0, 200),
          )
        }
      }
      if (isEdit && imageParts.length === 0) {
        throw new BadRequestError(
          `所有输入图片下载失败，无法进行图像编辑${firstDownloadError ? `｜${firstDownloadError}` : ''}`,
          {
            providerName: this.name,
          },
        )
      }
      if (isEdit && imageParts.length !== validUrls.length) {
        this.logger.warn(
          'provider=%s event=partial_reference_download attempted=%d succeeded=%d',
          this.name, validUrls.length, imageParts.length,
        )
      }
    } else if (isEdit) {
      throw new BadRequestError('图像编辑必须提供输入图片', { providerName: this.name })
    }

    const apiBase = this.apiBase ?? DEFAULT_API_BASE
    const endpoint = `${apiBase}/v1beta/models/${this.modelId}:generateContent`
    const generationConfig = this.buildGenerationConfig(contract, options)
    const safetySettings = buildSafetySettings()

    const requestData: Record<string, unknown> = {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }, ...imageParts],
        },
      ],
      generationConfig,
      safetySettings,
    }
    // 云雾扩展 response_format=url：仅在契约允许时携带
    if (
      contract.gemini?.supportsYunwuResponseFormatUrl
      && options?.contractFields?.responseFormat === 'url'
    ) {
      requestData.response_format = 'url'
    }

    if (this.shouldLogDetail()) {
      this.logger.info(
        'provider=%s event=request contract=%s endpoint=%s config=%s',
        this.name, contract.id, endpoint, JSON.stringify(generationConfig),
      )
    }

    const allImages: string[] = []
    for (let i = 0; i < numImages; i++) {
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

        const { images, totalTokens } = parseGeminiResponse(response, this.name, this.logger)
        this.lastTotalTokens = totalTokens
        if (images.length === 0) {
          this.logger.warn('provider=%s event=empty_response iteration=%d', this.name, i + 1)
          continue
        }
        for (const url of images) {
          const index = allImages.length
          allImages.push(url)
          await this.fireImageCallback(onImageGenerated, url, index, numImages)
        }
      } catch (error) {
        const normalized = error instanceof ProviderError ? error : this.handleProviderError(error)
        if (allImages.length > 0 && normalized.retryable === false) {
          this.logger.warn(
            'provider=%s event=partial_failed generated=%d requested=%d code=%s message=%s',
            this.name, allImages.length, numImages, normalized.code, sanitizeString(normalized.message),
          )
          break
        }
        throw normalized
      }
    }

    if (allImages.length === 0) {
      throw new ParseError('未能从 Gemini API 生成图片', { providerName: this.name })
    }
    return allImages
  }

  /**
   * 契约驱动的 generationConfig 构建：
   * - imageConfig.enabled=false → 完全不发 imageConfig（编辑契约）。
   * - aspectRatio 只在契约允许时发送。
   * - imageSize 只在契约声明的枚举内发送（大写 1K/2K/4K），云雾 2.5 不发送。
   */
  private buildGenerationConfig(
    contract: ImageContract,
    options: ImageGenerationOptions | undefined,
  ): Record<string, unknown> {
    const cap = contract.gemini!
    const responseModalities = cap.responseModalities ?? ['TEXT', 'IMAGE']
    const config: Record<string, unknown> = { responseModalities }

    if (cap.imageConfig.enabled) {
      const imageConfig: Record<string, unknown> = {}
      const aspectRatio = options?.contractFields?.aspectRatio ?? options?.aspectRatio
      if (aspectRatio) imageConfig.aspectRatio = aspectRatio

      const imageSizeRaw = options?.contractFields?.imageSize
      if (typeof imageSizeRaw === 'string' && imageSizeRaw) {
        imageConfig.imageSize = imageSizeRaw
      }

      if (Object.keys(imageConfig).length > 0) config.imageConfig = imageConfig
    }
    return config
  }
}

// -------- 模块级工具 --------

function parseGeminiResponse(
  rawResponse: unknown,
  providerName: string,
  logger: { debug: Function; warn: Function; error: Function; info?: Function }
): { images: string[]; totalTokens: number | null } {
  const response = (rawResponse ?? {}) as {
    error?: { message?: string }
    usageMetadata?: {
      promptTokenCount?: number
      candidatesTokenCount?: number
      totalTokenCount?: number
    }
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
    /** 云雾扩展 response_format=url 时的 URL 列表（顶层）。 */
    data?: Array<{ url?: string; b64_json?: string }>
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
    throw new BadRequestError(`请求被阻止 (${reason})${detail ? `: ${detail}` : ''}`, {
      providerName,
    })
  }

  const images: string[] = []

  // 云雾扩展：顶层 data[].url / b64_json
  if (Array.isArray(response.data)) {
    for (const item of response.data) {
      if (item.url) images.push(item.url)
      else if (item.b64_json) images.push(`data:image/png;base64,${item.b64_json}`)
    }
  }

  if (Array.isArray(response.candidates)) {
    for (const candidate of response.candidates) {
      const finishReason = candidate.finishReason
      if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
        if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
          const msg = `内容被阻止: ${finishReason}${candidate.finishMessage ? ` (${candidate.finishMessage})` : ''}`
          throw new ContentFilterError(msg, { providerName })
        }
        const hasParts = !!candidate.content?.parts && candidate.content.parts.length > 0
        if (!hasParts) {
          const msg = `生成失败: ${finishReason}${candidate.finishMessage ? `, ${candidate.finishMessage}` : ''}`
          logger.warn(
            'provider=%s event=finish_reason_anomaly reason=%s detail=%s',
            providerName, finishReason, candidate.finishMessage ?? '-',
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
            providerName, truncate(part.text, 100),
          )
        }
      }
    }
  }

  if (!Array.isArray(response.candidates) && !Array.isArray(response.data)) {
    throw new ParseError('Gemini API 响应中没有 candidates / data 也没有 promptFeedback', {
      providerName,
    })
  }

  const totalTokens = response.usageMetadata?.totalTokenCount ?? null
  return { images, totalTokens }
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
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function buildSafetySettings(): Array<{ category: string; threshold: string }> {
  return [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
  ]
}

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
