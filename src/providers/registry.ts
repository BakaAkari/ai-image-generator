import type { Context } from 'koishi'

import type { ImageProvider, ProviderFactory } from './types.js'

/**
 * Provider 注册表（7.11.4 节）
 *
 * 设计要点：
 * - 注册表实例是无状态的（只持有工厂引用）
 * - 实际 ImageProvider 实例通过 createProvider 即时构造，由调用方决定缓存策略
 * - 名字大小写不敏感
 *
 * 使用示例：
 * ```ts
 * const registry = new ProviderRegistry()
 * registry.register('openai-images', (ctx, cfg) => new OpenAIImagesProvider({ ctx, ...cfg }))
 * const provider = registry.createProvider('openai-images', ctx, cfg)
 * ```
 */
export class ProviderRegistry {
  private readonly factories = new Map<string, ProviderFactory>()

  /**
   * 注册一个 Provider 工厂。重复注册会覆盖前一次。
   */
  register(name: string, factory: ProviderFactory): void {
    this.factories.set(normalize(name), factory)
  }

  /**
   * 注销一个 Provider。
   */
  unregister(name: string): boolean {
    return this.factories.delete(normalize(name))
  }

  /** 列出所有已注册 Provider 名（按注册顺序） */
  list(): string[] {
    return Array.from(this.factories.keys())
  }

  /** 是否已注册 */
  has(name: string): boolean {
    return this.factories.has(normalize(name))
  }

  /**
   * 创建一个 Provider 实例。
   *
   * @throws 当 name 未注册时抛出
   */
  createProvider(
    name: string,
    ctx: Context,
    config: Record<string, unknown>
  ): ImageProvider {
    const factory = this.factories.get(normalize(name))
    if (!factory) {
      throw new Error(
        `Provider 未注册：'${name}'。可用：[${this.list().join(', ') || '<空>'}]`
      )
    }
    return factory(ctx, config)
  }
}

function normalize(name: string): string {
  return name.trim().toLowerCase()
}
