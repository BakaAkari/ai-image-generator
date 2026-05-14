import type { Context } from 'koishi'

/**
 * 图像生成参数
 *
 * 与 v1 的 ImageGenerationOptions 兼容，但移除了对 ProviderConfig 的依赖。
 * 配置通过构造函数注入而非选项字段传递，保持本结构精简。
 */
export interface ImageGenerationOptions {
  /** 分辨率预设：'1k' / '2k' / '4k' 或自定义 'WIDTHxHEIGHT'（如 '1024x1536'） */
  resolution?: '1k' | '2k' | '4k' | `${number}x${number}`
  /** 宽高比预设；当未指定 resolution 时由各 Provider 映射到具体尺寸 */
  aspectRatio?: '1:1' | '4:3' | '16:9' | '9:16' | '3:2' | '2:3'
}

/**
 * 流式回调：每生成一张图片就触发一次。
 *
 * - imageUrl 可能是远程 URL，也可能是 data:image/...;base64,... 的内嵌格式
 * - index 从 0 开始
 * - total 是请求的总张数（不一定等于最终成功生成数）
 */
export type ImageGeneratedCallback = (
  imageUrl: string,
  index: number,
  total: number
) => void | Promise<void>

/**
 * 图像供应商（统一接口）
 *
 * v2 相比 v1 的变化：
 * - 移除 ProviderConfig 字段（由具体子类构造函数管理）
 * - 错误统一抛出 ProviderError 子类（见 ./errors.ts）
 * - 通过基类 BaseImageProvider 共享 timeout / retry / 错误处理逻辑
 */
export interface ImageProvider {
  /** Provider 标识，例如 'openai' / 'gemini' */
  readonly name: string

  /**
   * 生成图像
   *
   * @param prompt 提示词
   * @param imageUrls 输入图片：空数组/空字符串表示文生图；否则为图生图（编辑）
   * @param numImages 期望生成数量
   * @param options 生成参数（分辨率/宽高比）
   * @param onImageGenerated 流式回调（每张生成完即调用）
   */
  generateImages(
    prompt: string,
    imageUrls: string | string[],
    numImages: number,
    options?: ImageGenerationOptions,
    onImageGenerated?: ImageGeneratedCallback
  ): Promise<string[]>
}

/**
 * BaseImageProvider 通用构造参数
 *
 * 各 Provider 子类的具体配置接口应继承本类型，再追加自身特定字段。
 */
export interface BaseProviderOptions {
  /** Koishi 上下文（用于 ctx.http、ctx.logger 等） */
  ctx: Context
  /** API 凭证 */
  apiKey: string
  /** 默认模型 ID */
  modelId: string
  /** API 基础地址（不带尾部斜杠） */
  apiBase?: string
  /** 单次 HTTP 请求超时时间（秒） */
  apiTimeout: number
  /** 日志级别（用于决定是否打印 debug） */
  logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug'
  /** 子 logger 名称，默认用 Provider name */
  loggerName?: string
  /** 第三方 OpenAI-compatible 站点所需的额外请求头 */
  extraHeaders?: Record<string, string>
}

/**
 * Provider 工厂函数签名（registry 使用）
 *
 * @param ctx Koishi 上下文
 * @param config 通过 Schema 验证后的 Provider 凭证 + 模型字段
 */
export type ProviderFactory = (ctx: Context, config: Record<string, unknown>) => ImageProvider
