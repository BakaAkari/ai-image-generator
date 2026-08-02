import type { FetchLike, ImageSupplierAdapter, SupplierCredentials } from './types.js'

export type SupplierAdapterFactory = (config: SupplierCredentials, fetchLike?: FetchLike) => ImageSupplierAdapter | null

/**
 * 供应商适配器注册表
 *
 * 设计要点：
 * - 注册表实例是无状态的（只持有工厂引用）
 * - 实际 ImageSupplierAdapter 实例通过 create 即时构造，由调用方决定缓存策略
 * - ID 大小写不敏感
 *
 * 使用示例：
 * ```ts
 * const registry = new SupplierRegistry()
 * registry.register('newapi', (config, fetchLike) => new NewApiClient(config, fetchLike))
 * const adapter = registry.create('newapi', config)
 * ```
 */
export class SupplierRegistry {
  private readonly factories = new Map<string, SupplierAdapterFactory>()

  /**
   * 注册一个供应商适配器工厂。重复注册会覆盖前一次。
   */
  register(id: string, factory: SupplierAdapterFactory): void {
    this.factories.set(normalize(id), factory)
  }

  /**
   * 注销一个供应商适配器。
   */
  unregister(id: string): boolean {
    return this.factories.delete(normalize(id))
  }

  /** 列出所有已注册供应商 ID（按注册顺序） */
  list(): string[] {
    return Array.from(this.factories.keys())
  }

  /** 是否已注册 */
  has(id: string): boolean {
    return this.factories.has(normalize(id))
  }

  /**
   * 创建一个供应商适配器实例。
   *
   * @returns 适配器实例；若 ID 未注册则返回 null
   */
  create(id: string, config: SupplierCredentials, fetchLike?: FetchLike): ImageSupplierAdapter | null {
    const factory = this.factories.get(normalize(id))
    if (!factory) {
      return null
    }
    return factory(config, fetchLike)
  }
}

function normalize(id: string): string {
  return id.trim().toLowerCase()
}
