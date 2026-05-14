import type { Context, Logger } from 'koishi'

import {
  AuthenticationError,
  BadRequestError,
  ContentFilterError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  normalizeProviderError,
} from './errors.js'
import type {
  BaseProviderOptions,
  ImageGeneratedCallback,
  ImageGenerationOptions,
  ImageProvider,
} from './types.js'
import { withRetry, type RetryOptions } from './policies/retry.js'
import { withTimeout } from './policies/timeout.js'
import { isDetailLogLevel, normalizeLogLevel } from '../shared/logging.js'

/**
 * BaseImageProvider（7.2 节）
 *
 * 所有图像 Provider 子类的基类，统一负责：
 * - 构造参数管理
 * - 请求头构造
 * - 超时 / 重试 / 错误归一化
 * - 流式回调安全调用
 *
 * 子类只需要实现 generateImages() 即可。
 */
export abstract class BaseImageProvider implements ImageProvider {
  /** Provider 标识，由子类设定 */
  abstract readonly name: string

  protected readonly ctx: Context
  protected readonly logger: Logger
  protected readonly apiKey: string
  protected readonly modelId: string
  protected readonly apiBase: string | undefined
  protected readonly apiTimeoutSeconds: number
  protected readonly logLevel: BaseProviderOptions['logLevel']
  protected readonly extraHeaders: Record<string, string>

  constructor(options: BaseProviderOptions) {
    this.ctx = options.ctx
    this.apiKey = options.apiKey
    this.modelId = options.modelId
    this.apiBase = options.apiBase?.replace(/\/$/, '') || undefined
    this.apiTimeoutSeconds = options.apiTimeout
    this.logLevel = normalizeLogLevel(options.logLevel)
    this.extraHeaders = options.extraHeaders ?? {}
    this.logger = options.ctx.logger(options.loggerName ?? 'aka-ai-image-generator:provider')
  }

  abstract generateImages(
    prompt: string,
    imageUrls: string | string[],
    numImages: number,
    options?: ImageGenerationOptions,
    onImageGenerated?: ImageGeneratedCallback
  ): Promise<string[]>

  // -------- 通用工具 --------

  protected shouldLogDetail(): boolean {
    return isDetailLogLevel(this.logLevel)
  }

  /** 构造常规 Bearer 鉴权头 */
  protected buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...this.extraHeaders,
      ...extra,
    }
  }

  /** 获取以毫秒为单位的超时阈值 */
  protected getTimeoutMs(): number {
    return Math.max(0, this.apiTimeoutSeconds * 1000)
  }

  /**
   * 用 timeout 包装 promise；超时抛 TimeoutError。
   *
   * 子类一般不必直接调用，可通过 callApi 的封装。
   */
  protected withTimeout<T>(promise: Promise<T>, message?: string): Promise<T> {
    return withTimeout(promise, {
      timeoutMs: this.getTimeoutMs(),
      message,
      providerName: this.name,
    })
  }

  /**
   * 在 retry + timeout 包装下执行一次 API 调用。
   *
   * @param fn 实际的 HTTP 请求执行体
   * @param retryOptions 自定义重试配置（可省略）
   */
  protected async callApi<T>(
    fn: () => Promise<T>,
    retryOptions?: Omit<RetryOptions, 'providerName' | 'onRetry'>
  ): Promise<T> {
    return withRetry(
      () =>
        this.withTimeout(fn()).catch((err: unknown) => {
          throw this.handleProviderError(err)
        }),
      {
        providerName: this.name,
        onRetry: (err, attempt, delayMs) => {
          this.logger.warn(
            'provider=%s event=retry attempt=%d delay_ms=%d code=%s status=%s retryable=%s message=%s context=%s',
            this.name,
            attempt,
            delayMs,
            err.code,
            err.statusCode ?? '-',
            err.retryable,
            err.message,
            safeStringify(err.context),
          )
        },
        ...retryOptions,
      }
    )
  }

  /**
   * 把异常归一化为 ProviderError 子类，并把内容审核类的关键字识别成 ContentFilterError。
   * 子类如果需要识别更具体的错误码，可重写本方法。
   */
  protected handleProviderError(error: unknown): ProviderError {
    const normalized = normalizeProviderError(error, this.name)

    // 已经是具体子类则直接返回
    if (
      normalized instanceof AuthenticationError ||
      normalized instanceof RateLimitError ||
      normalized instanceof BadRequestError ||
      normalized instanceof TimeoutError ||
      normalized instanceof ContentFilterError
    ) {
      return normalized
    }

    // 内容审核兜底（不同 Provider 关键词不同；子类可覆盖）
    if (isContentFilterMessage(normalized.message)) {
      return new ContentFilterError(normalized.message, {
        providerName: this.name,
        statusCode: normalized.statusCode,
        cause: normalized.cause,
      })
    }

    return normalized
  }

  /**
   * 流式回调安全包装：把回调失败转换为 Promise.reject，但不影响 Provider 内部状态。
   */
  protected async fireImageCallback(
    onImageGenerated: ImageGeneratedCallback | undefined,
    imageUrl: string,
    index: number,
    total: number
  ): Promise<void> {
    if (!onImageGenerated) return
    try {
      await onImageGenerated(imageUrl, index, total)
    } catch (err) {
      this.logger.error('provider=%s event=callback_failed index=%d total=%d error=%s', this.name, index, total, describeError(err))
      throw err
    }
  }
}

// -------- internal helpers --------

const CONTENT_FILTER_KEYWORDS = [
  'safety system',
  'content_policy_violation',
  'content policy',
  'safety_violation',
  'image_generation_user_error',
  'inappropriate',
  '违规',
  '违反',
  '内容审核',
]

function isContentFilterMessage(message: string): boolean {
  const lower = message.toLowerCase()
  return CONTENT_FILTER_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()))
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return String(value)
  }
}
