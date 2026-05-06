/**
 * Provider 统一错误体系（Phase 2 / 7.4 节）
 *
 * 所有 Provider 子类抛出的错误都应包装为 ProviderError 的某个子类。
 * 上层（Service / Orchestrator）只需要：
 *   - 检查 instanceof ProviderError 判定是否来自 Provider 层
 *   - 检查 .retryable 判断是否值得重试
 *   - 读取 .code / .providerName 输出友好日志
 */

/** 错误码：用于上层做精确判断（Schema 化错误处理） */
export type ProviderErrorCode =
  | 'AUTHENTICATION'
  | 'RATE_LIMIT'
  | 'CONTENT_FILTER'
  | 'TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'BAD_REQUEST'
  | 'PARSE_ERROR'
  | 'UNKNOWN'

export interface ProviderErrorOptions {
  /** 出错的 Provider 名（如 'openai-images'） */
  providerName?: string
  /** 上游 HTTP 状态码（若有） */
  statusCode?: number
  /** 是否值得重试（默认按 code 判断） */
  retryable?: boolean
  /** 原始错误（保留 cause 链） */
  cause?: unknown
  /** 上下文键值对（log 用，不要包含密钥） */
  context?: Record<string, unknown>
}

/**
 * Provider 层基础错误。
 * 业务代码不要直接 throw 该类，应使用具体子类。
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly providerName: string | undefined
  readonly statusCode: number | undefined
  readonly retryable: boolean
  override readonly cause: unknown
  readonly context: Record<string, unknown>

  constructor(code: ProviderErrorCode, message: string, options: ProviderErrorOptions = {}) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.providerName = options.providerName
    this.statusCode = options.statusCode
    this.retryable = options.retryable ?? defaultRetryable(code)
    this.cause = options.cause
    this.context = options.context ?? {}
  }

  /** 转结构化日志对象（不含敏感字段） */
  toLogObject(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      providerName: this.providerName,
      statusCode: this.statusCode,
      retryable: this.retryable,
      context: this.context,
    }
  }
}

/** 401/403：API key 无效或权限不足 */
export class AuthenticationError extends ProviderError {
  constructor(message: string, options: ProviderErrorOptions = {}) {
    super('AUTHENTICATION', message, { retryable: false, ...options })
    this.name = 'AuthenticationError'
  }
}

/** 429：速率限制或配额耗尽 */
export class RateLimitError extends ProviderError {
  /** 服务端建议的重试间隔（秒），若 header 中给出 */
  readonly retryAfterSeconds: number | undefined

  constructor(
    message: string,
    options: ProviderErrorOptions & { retryAfterSeconds?: number } = {}
  ) {
    super('RATE_LIMIT', message, { retryable: true, ...options })
    this.name = 'RateLimitError'
    this.retryAfterSeconds = options.retryAfterSeconds
  }
}

/** 内容审核拦截（Provider 主动拒绝；用户行为问题，不应自动重试） */
export class ContentFilterError extends ProviderError {
  constructor(message: string, options: ProviderErrorOptions = {}) {
    super('CONTENT_FILTER', message, { retryable: false, ...options })
    this.name = 'ContentFilterError'
  }
}

/** 请求超时（含网络层和 API 业务超时） */
export class TimeoutError extends ProviderError {
  /** 触发的超时阈值（秒） */
  readonly timeoutSeconds: number | undefined

  constructor(
    message: string,
    options: ProviderErrorOptions & { timeoutSeconds?: number } = {}
  ) {
    super('TIMEOUT', message, { retryable: true, ...options })
    this.name = 'TimeoutError'
    this.timeoutSeconds = options.timeoutSeconds
  }
}

/** Provider 不可用：5xx、网络断开、DNS 失败等 */
export class ProviderUnavailableError extends ProviderError {
  constructor(message: string, options: ProviderErrorOptions = {}) {
    super('PROVIDER_UNAVAILABLE', message, { retryable: true, ...options })
    this.name = 'ProviderUnavailableError'
  }
}

/** 400/422：请求参数非法 */
export class BadRequestError extends ProviderError {
  constructor(message: string, options: ProviderErrorOptions = {}) {
    super('BAD_REQUEST', message, { retryable: false, ...options })
    this.name = 'BadRequestError'
  }
}

/** 响应格式异常（解析阶段抛出） */
export class ParseError extends ProviderError {
  constructor(message: string, options: ProviderErrorOptions = {}) {
    super('PARSE_ERROR', message, { retryable: false, ...options })
    this.name = 'ParseError'
  }
}

/**
 * 把任意错误归一化为 ProviderError 子类。
 *
 * - 已经是 ProviderError 子类时直接返回
 * - 含有 response.status 等字段的 HTTPError 按状态码映射
 * - 其他未知错误返回 ProviderError(code='UNKNOWN')
 */
export function normalizeProviderError(
  error: unknown,
  providerName?: string
): ProviderError {
  if (error instanceof ProviderError) return error

  const err = error as
    | (Error & { response?: { status?: number; data?: unknown }; status?: number; code?: string })
    | undefined

  const message = err?.message ?? '未知错误'
  const statusCode = err?.response?.status ?? err?.status

  const baseOptions: ProviderErrorOptions = {
    providerName,
    statusCode,
    cause: error,
  }

  if (statusCode === 401 || statusCode === 403) {
    return new AuthenticationError(message, baseOptions)
  }
  if (statusCode === 429) {
    return new RateLimitError(message, baseOptions)
  }
  if (statusCode === 400 || statusCode === 422) {
    return new BadRequestError(message, baseOptions)
  }
  if (typeof statusCode === 'number' && statusCode >= 500) {
    return new ProviderUnavailableError(message, baseOptions)
  }

  // Node fetch / undici 网络层错误
  const code = err?.code
  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    /timeout/i.test(message)
  ) {
    return new TimeoutError(message, baseOptions)
  }
  if (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    /fetch.*failed/i.test(message)
  ) {
    return new ProviderUnavailableError(message, baseOptions)
  }

  return new ProviderError('UNKNOWN', message, baseOptions)
}

function defaultRetryable(code: ProviderErrorCode): boolean {
  switch (code) {
    case 'RATE_LIMIT':
    case 'TIMEOUT':
    case 'PROVIDER_UNAVAILABLE':
      return true
    case 'AUTHENTICATION':
    case 'CONTENT_FILTER':
    case 'BAD_REQUEST':
    case 'PARSE_ERROR':
      return false
    default:
      return false
  }
}
