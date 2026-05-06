import { TimeoutError } from '../errors.js'

/**
 * 超时策略（7.11.1 节）
 *
 * 提供与 AbortController 兼容的统一超时包装。所有 Provider 都应使用本工具，
 * 而非直接 setTimeout，避免出现"超时但 promise 仍在 resolve"的双触发问题。
 */

export interface WithTimeoutOptions {
  /** 超时阈值（毫秒） */
  timeoutMs: number
  /** 超时错误信息（不含敏感内容） */
  message?: string
  /** 用于日志识别的 Provider 名 */
  providerName?: string
}

/**
 * 用 timeout 包裹 promise；超时则抛出 TimeoutError。
 *
 * 注意：本函数不会取消底层的网络请求，只会让外层不再等待。如果需要取消，
 * 调用方应自行管理 AbortController（参见 withAbortableTimeout）。
 */
export function withTimeout<T>(promise: Promise<T>, options: WithTimeoutOptions): Promise<T> {
  const { timeoutMs, message, providerName } = options

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise
  }

  let timer: ReturnType<typeof setTimeout> | undefined

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new TimeoutError(message ?? `请求超时（${Math.round(timeoutMs / 1000)}秒）`, {
          providerName,
          timeoutSeconds: Math.round(timeoutMs / 1000),
        })
      )
    }, timeoutMs)
  })

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * 带 AbortController 的超时包装：超时时主动 abort，释放底层连接。
 *
 * @example
 * const ac = new AbortController()
 * const result = await withAbortableTimeout(
 *   (signal) => ctx.http.post(url, body, { signal }),
 *   { timeoutMs: 30_000 }
 * )
 */
export async function withAbortableTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: WithTimeoutOptions
): Promise<T> {
  const { timeoutMs, message, providerName } = options
  const ac = new AbortController()

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fn(ac.signal)
  }

  const timer = setTimeout(() => ac.abort(), timeoutMs)

  try {
    return await fn(ac.signal)
  } catch (err) {
    if (ac.signal.aborted) {
      throw new TimeoutError(message ?? `请求超时（${Math.round(timeoutMs / 1000)}秒）`, {
        providerName,
        timeoutSeconds: Math.round(timeoutMs / 1000),
        cause: err,
      })
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
