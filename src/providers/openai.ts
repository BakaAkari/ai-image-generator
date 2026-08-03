import type { Context } from 'koishi'

import { BaseImageProvider } from './base.js'
import { BadRequestError, ContentFilterError, ParseError, ProviderError } from './errors.js'
import type {
  BaseProviderOptions,
  ImageGeneratedCallback,
  ImageGenerationOptions,
} from './types.js'
import { downloadImageAsBase64, sanitizeError, sanitizeString } from './utils.js'
import { resolveOpenAiSize } from '../contracts/openai-size.js'
import type { ImageContract } from '../contracts/types.js'

export type OpenAIProviderOptions = BaseProviderOptions

/** GPT Image 模型最低超时（秒），弥补上游生成耗时。 */
const GPT_IMAGE_MIN_TIMEOUT_SECONDS = 180

const DEFAULT_API_BASE = 'https://api.openai.com/v1'

interface OpenAIImagesResponse {
  error?: { message?: string; type?: string; code?: string }
  data?: Array<{
    b64_json?: string
    url?: string
    revised_prompt?: string
  }>
  usage?: {
    total_tokens?: number
    input_tokens?: number
    output_tokens?: number
    input_tokens_details?: { image_tokens?: number; text_tokens?: number }
    output_tokens_details?: { image_tokens?: number; text_tokens?: number }
  }
}

/** ctx.http 可调用形式返回的完整响应（含 headers，用于捕获 x-routing-group）。 */
interface OpenAIImageHttpResponse {
  data: OpenAIImagesResponse
  headers: { get: (name: string) => string | null }
}

/**
 * OpenAIProvider（契约驱动版）。
 *
 * - Create：JSON `/v1/images/generations`。
 * - Edit：直接使用 multipart/form-data `/v1/images/edits`，不再先尝试 JSON。
 * - size / quality / format / background / moderation 全部由契约的 openai capability 决定；
 *   由服务层预先通过 param-resolver 校验并放入 contractFields。
 * - contract 缺失时 fail-closed 报错（服务层已保证契约存在，此处只做兜底防御）。
 */
export class OpenAIProvider extends BaseImageProvider {
  override readonly name: string = 'openai'

  private getEffectiveTimeoutSeconds(): number {
    const configured = this.apiTimeoutSeconds
    const modelId = this.modelId.toLowerCase()
    if (modelId.startsWith('gpt-image')) {
      return Math.max(configured, GPT_IMAGE_MIN_TIMEOUT_SECONDS)
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
    const contract = options?.contract
    if (!contract) {
      throw new BadRequestError('OpenAI 请求缺少精确契约，fail-closed', {
        providerName: this.name,
      })
    }
    // Provider 层兜底：如果绕过 Service/generation-setup 直接调用，
    // 仍要求 rejectedParams 为空，避免使用被契约拒绝的显式参数继续请求。
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
        'provider=%s event=generate_detail contract=%s operation=%s has_input=%s input_count=%d num=%d model=%s api_base=%s timeout_ms=%d fields=%s rejected=%s',
        this.name,
        contract.id,
        contract.operation,
        validUrls.length > 0,
        validUrls.length,
        numImages,
        this.modelId,
        this.getApiBase(),
        this.getTimeoutMs(),
        JSON.stringify(Object.keys(options?.contractFields ?? {})),
        JSON.stringify(options?.rejectedParams ?? []),
      )
    }

    // 编辑操作必须有参考图；文生图不允许携带参考图（fail-closed）
    if (isEdit && validUrls.length === 0) {
      throw new BadRequestError('图像编辑必须提供输入图片', { providerName: this.name })
    }

    const size = this.resolveSize(contract, options)

    try {
      if (isEdit) {
        return await this.editImages(contract, prompt, validUrls, numImages, size, options, onImageGenerated)
      }
      return await this.createImages(contract, prompt, numImages, size, options, onImageGenerated)
    } catch (error) {
      const normalized = error instanceof ProviderError ? error : this.handleProviderError(error)
      this.logger.error(
        'provider=%s event=generate_failed contract=%s code=%s status=%s retryable=%s message=%s',
        this.name,
        contract.id,
        normalized.code,
        normalized.statusCode ?? '-',
        normalized.retryable,
        sanitizeString(normalized.message),
      )
      throw normalized
    }
  }

  private resolveSize(contract: ImageContract, options?: ImageGenerationOptions): string | undefined {
    const cap = contract.openai?.size
    if (!cap) return undefined
    // contract-driven 分支已把 size 放入 contractFields.size；若未提供 → 由 openai-size 兜底
    const injected = options?.contractFields?.size
    if (typeof injected === 'string') return injected
    const resolved = resolveOpenAiSize({
      ...(options?.aspectRatio !== undefined ? { aspectRatio: options.aspectRatio } : {}),
      ...(options?.resolution !== undefined ? { resolution: options.resolution } : {}),
      capability: cap,
    })
    if (!resolved.ok) {
      throw new BadRequestError(resolved.error, { providerName: this.name })
    }
    return resolved.size
  }

  /**
   * 捕获 new-api 响应头 x-routing-group（本次实际路由分组，后生成结算用）。
   * 大小写不敏感（Headers.get 本身不区分大小写）；取不到时保持 null。
   */
  private captureRoutingGroup(headers: { get: (name: string) => string | null } | null | undefined): void {
    const value = headers?.get('x-routing-group')?.trim()
    this.lastRoutingGroup = value && value.length > 0 ? value : null
  }

  private getApiBase(): string {
    return normalizeV1Base(this.apiBase ?? DEFAULT_API_BASE)
  }

  private buildCreateBody(
    contract: ImageContract,
    prompt: string,
    size: string | undefined,
    n: number,
    fields: Record<string, string | number>,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.modelId,
      prompt,
      n,
    }
    if (size) body.size = size
    if (contract.openai?.qualities && fields.quality) body.quality = fields.quality
    if (contract.openai?.formats && fields.format) body.format = fields.format
    if (contract.openai?.backgrounds && fields.background) body.background = fields.background
    if (contract.openai?.moderations && fields.moderation) body.moderation = fields.moderation
    return body
  }

  private async createImages(
    contract: ImageContract,
    prompt: string,
    numImages: number,
    size: string | undefined,
    options: ImageGenerationOptions | undefined,
    onImageGenerated?: ImageGeneratedCallback,
  ): Promise<string[]> {
    const apiBase = this.getApiBase()
    const endpoint = `${apiBase}/images/generations`
    const fields = options?.contractFields ?? {}

    // 契约不支持 n>1 时逐张调用；否则一次调用请求 numImages 张
    const supportsMultiN = !!contract.openai?.supportsN
    const perCall = supportsMultiN ? numImages : 1
    const iterations = supportsMultiN ? 1 : numImages
    const allImages: string[] = []

    for (let i = 0; i < iterations; i++) {
      const body = this.buildCreateBody(contract, prompt, size, perCall, fields)
      if (this.shouldLogDetail()) {
        this.logger.info(
          'provider=%s event=create_request contract=%s iteration=%d n=%d fields=%s',
          this.name, contract.id, i + 1, perCall, JSON.stringify(redactRequestBody(body)),
        )
      }

      const response = await this.callApi<OpenAIImageHttpResponse>(() =>
        (this.ctx.http as unknown as {
          (url: string, config: Record<string, unknown>): Promise<OpenAIImageHttpResponse>
        })(endpoint, {
          method: 'POST',
          data: body,
          headers: this.buildHeaders(),
          timeout: this.getTimeoutMs(),
        })
      )

      this.captureRoutingGroup(response?.headers)
      const parsed = parseOpenAIImagesResponse(response?.data)
      this.lastTotalTokens = parsed.totalTokens ?? this.lastTotalTokens
      this.lastInputTokens = parsed.inputTokens ?? this.lastInputTokens
      this.lastOutputTokens = parsed.outputTokens ?? this.lastOutputTokens
      if (parsed.images.length === 0) {
        this.logger.warn('provider=%s event=create_empty_response iteration=%d', this.name, i + 1)
        continue
      }
      for (const url of parsed.images) {
        const index = allImages.length
        allImages.push(url)
        await this.fireImageCallback(onImageGenerated, url, index, numImages)
      }
    }

    if (allImages.length === 0) {
      throw new ParseError('未能生成任何图片', { providerName: this.name })
    }
    return allImages
  }

  private async editImages(
    contract: ImageContract,
    prompt: string,
    imageUrls: string[],
    numImages: number,
    size: string | undefined,
    options: ImageGenerationOptions | undefined,
    onImageGenerated?: ImageGeneratedCallback,
  ): Promise<string[]> {
    const apiBase = this.getApiBase()
    const endpoint = `${apiBase}/images/edits`
    const fields = options?.contractFields ?? {}

    const imageDataList: Array<{ data: string; mimeType: string }> = []
    let firstDownloadError: string | undefined
    for (const url of imageUrls) {
      try {
        const result = await downloadImageAsBase64(this.ctx, url, this.apiTimeoutSeconds, this.logger)
        imageDataList.push(result)
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
    if (imageDataList.length === 0) {
      throw new BadRequestError(
        `所有输入图片下载失败，无法进行图像编辑${firstDownloadError ? `｜${firstDownloadError}` : ''}`,
        {
          providerName: this.name,
        },
      )
    }

    const supportsMultiN = !!contract.openai?.supportsN
    const perCall = supportsMultiN ? numImages : 1
    const iterations = supportsMultiN ? 1 : numImages
    const allImages: string[] = []

    for (let i = 0; i < iterations; i++) {
      const formData = new FormData()
      for (let idx = 0; idx < imageDataList.length; idx++) {
        const img = imageDataList[idx]!
        formData.append('image', base64ToBlob(img.data, img.mimeType), `image_${idx}.png`)
      }
      formData.append('prompt', prompt)
      formData.append('model', this.modelId)
      formData.append('n', String(perCall))
      if (size) formData.append('size', size)
      if (contract.openai?.qualities && fields.quality) formData.append('quality', String(fields.quality))
      if (contract.openai?.backgrounds && fields.background) formData.append('background', String(fields.background))
      if (contract.openai?.moderations && fields.moderation) formData.append('moderation', String(fields.moderation))

      if (this.shouldLogDetail()) {
        this.logger.info(
          'provider=%s event=edit_request contract=%s iteration=%d n=%d image_count=%d size=%s',
          this.name, contract.id, i + 1, perCall, imageDataList.length, size ?? '-',
        )
      }

      const response = await this.callApi<OpenAIImageHttpResponse>(() =>
        (this.ctx.http as unknown as {
          (url: string, config: Record<string, unknown>): Promise<OpenAIImageHttpResponse>
        })(endpoint, {
          method: 'POST',
          data: formData,
          headers: { Authorization: `Bearer ${this.apiKey}` },
          timeout: this.getTimeoutMs(),
        })
      )

      this.captureRoutingGroup(response?.headers)
      const parsed = parseOpenAIImagesResponse(response?.data)
      this.lastTotalTokens = parsed.totalTokens ?? this.lastTotalTokens
      this.lastInputTokens = parsed.inputTokens ?? this.lastInputTokens
      this.lastOutputTokens = parsed.outputTokens ?? this.lastOutputTokens
      if (parsed.images.length === 0) {
        this.logger.warn('provider=%s event=edit_empty_response iteration=%d', this.name, i + 1)
        continue
      }
      for (const url of parsed.images) {
        const index = allImages.length
        allImages.push(url)
        await this.fireImageCallback(onImageGenerated, url, index, numImages)
      }
    }

    if (allImages.length === 0) {
      throw new ParseError('未能生成任何图片', { providerName: this.name })
    }
    return allImages
  }
}

// -------- 模块级工具 --------

export function parseOpenAIImagesResponse(response: OpenAIImagesResponse | undefined): {
  images: string[]
  totalTokens: number | null
  inputTokens: number | null
  outputTokens: number | null
} {
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
  if (!Array.isArray(data)) return { images: [], totalTokens: null, inputTokens: null, outputTokens: null }
  const images: string[] = []
  for (const item of data) {
    if (item.b64_json) {
      images.push(`data:image/png;base64,${item.b64_json}`)
    } else if (item.url) {
      images.push(item.url)
    }
  }
  const totalTokens = response.usage?.total_tokens ?? null
  const inputTokens = response.usage?.input_tokens ?? null
  const outputTokens = response.usage?.output_tokens ?? null
  return { images, totalTokens, inputTokens, outputTokens }
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
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function redactRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (key === 'prompt' && typeof value === 'string') {
      result.promptLength = value.length
    } else {
      result[key] = value
    }
  }
  return result
}

/**
 * 工厂函数。
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

export function normalizeV1Base(apiBase: string): string {
  const trimmed = apiBase.replace(/\/$/, '')
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === 'string')
}
