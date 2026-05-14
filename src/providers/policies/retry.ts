import { ProviderError, RateLimitError, normalizeProviderError } from '../errors.js'

/**
 * 重试策略（7.11.2 节）
 *
 * 默认仅对 retryable 的 ProviderError 重试。其他错误类型直接向上抛。
 */

export interface RetryOptions {
  /** 最大重试次数（不含首次调用），默认 2 */
  maxRetries?: number
  /** 初始退避（毫秒），默认 500 */
  initialDelayMs?: number
  /** 最大退避（毫秒），默认 8000 */
  maxDelayMs?: number
  /** 退避乘数，默认 2 */
  backoffFactor?: number
  /** 抖动比例（0~1），默认 0.2 */
  jitter?: number
  /** 自定义重试判定（覆盖默认行为） */
  shouldRetry?: (error: ProviderError, attempt: number) => boolean
  /** 每次重试前回调（用于日志） */
  onRetry?: (error: ProviderError, attempt: number, delayMs: number) => void
  /** Provider 名（normalizeProviderError 用） */
  providerName?: string
}

/**
 * 用指数退避策略重试 fn。
 *
 * @example
 * const images = await withRetry(
 *   () => provider.callApi(...),
 *   { maxRetries: 3, providerName: 'openai' }
 * )
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxRetries = 2,
    initialDelayMs = 500,
    maxDelayMs = 8000,
    backoffFactor = 2,
    jitter = 0.2,
    shouldRetry,
    onRetry,
    providerName,
  } = options

  let attempt = 0
  let lastError: ProviderError | undefined

  // attempt 包含首次：0 = 初次，1..maxRetries = 重试
  while (attempt <= maxRetries) {
    try {
      return await fn()
    } catch (rawError) {
      const err = normalizeProviderError(rawError, providerName)
      lastError = err

      const canRetry = shouldRetry ? shouldRetry(err, attempt) : err.retryable
      if (!canRetry || attempt >= maxRetries) {
        throw err
      }

      // 计算下次退避：优先尊重 RateLimitError 的 retryAfterSeconds
      let delayMs: number
      if (err instanceof RateLimitError && err.retryAfterSeconds !== undefined) {
        delayMs = err.retryAfterSeconds * 1000
      } else {
        const base = initialDelayMs * Math.pow(backoffFactor, attempt)
        const capped = Math.min(base, maxDelayMs)
        const jitterAmount = capped * jitter * (Math.random() * 2 - 1)
        delayMs = Math.max(0, Math.round(capped + jitterAmount))
      }

      onRetry?.(err, attempt + 1, delayMs)

      await sleep(delayMs)
      attempt += 1
    }
  }

  // 不应到达此处；为类型安全保留
  throw lastError ?? new ProviderError('UNKNOWN', '重试逻辑出现未预期的退出', { providerName })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
