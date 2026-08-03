import type { Context } from 'koishi'

import type { LogLevel } from '../shared/logging.js'
import type { ImageContract, ContractOperation } from '../contracts/types.js'

/**
 * 图像生成参数
 *
 * 与 v1 的 ImageGenerationOptions 兼容；本轮新增精确契约、操作类型和 rejected 参数列表
 * 以支持契约驱动的请求构建。契约不为空时，provider 严格按契约生成请求。
 */
export interface ImageGenerationOptions {
  /** 分辨率预设：'1k' / '2k' / '4k' 或自定义 'WIDTHxHEIGHT'（如 '1024x1536'） */
  resolution?: '1k' | '2k' | '4k' | `${number}x${number}`
  /** 宽高比预设；当未指定 resolution 时由各 Provider 映射到具体尺寸 */
  aspectRatio?: '1:1' | '4:3' | '16:9' | '9:16' | '3:2' | '2:3'
  /** 精确契约。provider 若能识别该 id/字段，将按契约构建请求；否则应 fail-closed。 */
  contract?: ImageContract
  /** 生成操作；provider 需按此决定 API 分支（如 create vs edit）。 */
  operation?: ContractOperation
  /** 契约参数解析出的额外字段（quality/format/background/moderation/imageSize/botType 等）。 */
  contractFields?: Record<string, string | number>
  /** 用户显式但被契约拒绝的参数（provider 或上层用于报错）。 */
  rejectedParams?: Array<{ key: string; value: unknown; reason: string }>
  /** 目标生成张数（provider 需在契约允许时批量或串行调度）。 */
  numImages?: number
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

  /** 最近一次生成调用返回的 usage.total_tokens（后生成定价用）。null 表示未获取到或调用尚未完成。 */
  lastTotalTokens: number | null

  /** 最近一次生成调用返回的 usage.input_tokens（per-token 精确结算用）。 */
  lastInputTokens: number | null

  /** 最近一次生成调用返回的 usage.output_tokens（per-token 精确结算用）。 */
  lastOutputTokens: number | null

  /** 最近一次生成调用响应头里的 x-routing-group（new-api 路由分组，后生成结算用）。 */
  lastRoutingGroup: string | null

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
  /** 日志级别；simple 只记录关键流程，detail 增加脱敏诊断 */
  logLevel?: LogLevel
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
