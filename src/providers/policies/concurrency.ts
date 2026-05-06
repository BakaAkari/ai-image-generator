/**
 * 并发限流策略（7.11.10 节）
 *
 * 用于限制对同一 Provider 的并发请求数。每个 Provider 实例可拥有自己的 limiter，
 * 也可在全局 Service 层共享一个 limiter 做整体限流。
 */

interface QueueItem<T> {
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason: unknown) => void
  fn: () => Promise<T>
}

export interface ConcurrencyLimiterOptions {
  /** 最大并发数 */
  maxConcurrent: number
  /** 队列长度上限；超出立即抛错。0 或不传表示无上限 */
  maxQueue?: number
}

export class ConcurrencyLimiter {
  private readonly maxConcurrent: number
  private readonly maxQueue: number
  private active = 0
  private readonly queue: Array<QueueItem<unknown>> = []

  constructor(options: ConcurrencyLimiterOptions) {
    if (!Number.isFinite(options.maxConcurrent) || options.maxConcurrent < 1) {
      throw new RangeError('maxConcurrent 必须 >= 1')
    }
    this.maxConcurrent = Math.floor(options.maxConcurrent)
    this.maxQueue = options.maxQueue ?? 0
  }

  /** 当前活跃任务数 */
  get activeCount(): number {
    return this.active
  }

  /** 当前排队任务数 */
  get queueLength(): number {
    return this.queue.length
  }

  /**
   * 在并发限制下执行 fn。
   *
   * 若已达 maxConcurrent，则进入队列等待；若队列也已满则立即抛出。
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.maxQueue > 0 && this.queue.length >= this.maxQueue && this.active >= this.maxConcurrent) {
        reject(new Error(`并发队列已满（max=${this.maxQueue}），请稍后重试`))
        return
      }

      const item: QueueItem<T> = { resolve, reject, fn }
      this.queue.push(item as QueueItem<unknown>)
      this.drain()
    })
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift()
      if (!item) break

      this.active += 1
      // 不能 await，否则后续任务无法并发
      Promise.resolve()
        .then(() => item.fn())
        .then(
          (value) => {
            item.resolve(value)
          },
          (err: unknown) => {
            item.reject(err)
          }
        )
        .finally(() => {
          this.active -= 1
          this.drain()
        })
    }
  }
}
