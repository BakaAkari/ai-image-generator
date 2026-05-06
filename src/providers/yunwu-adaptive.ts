import type { Context } from 'koishi'

import { GeminiProvider, createGeminiProvider } from './gemini.js'
import { OpenAIImagesProvider, createOpenAIImagesProvider } from './openai-images.js'
import type {
  ImageGeneratedCallback,
  ImageGenerationOptions,
  ImageProvider,
} from './types.js'

/**
 * 云雾 API 协议格式
 *
 * - `gemini`：使用 Google Gemini 兼容协议（默认，对应 v1 fallback 行为）
 * - `openai`：使用 OpenAI Images 兼容协议（对应 v1 apiFormat='openai' 行为）
 */
export type YunwuApiFormat = 'gemini' | 'openai'

/**
 * 云雾自适应 Provider 默认 base
 */
const DEFAULT_API_BASE = 'https://yunwu.ai'

/**
 * YunwuAdaptiveProvider（v2 新增）
 *
 * 包装 GeminiProvider / OpenAIImagesProvider，根据 `apiFormat` 字段
 * 选择内部委托对象。同一供应商可同时支持两种协议而无需用户切换 provider 类型。
 *
 * 设计要点：
 * - 不继承 BaseImageProvider —— 所有运行时能力由内部委托提供
 * - 仅暴露 `name = 'yunwu-adaptive'` 用于日志区分
 * - 委托对象的 apiBase 默认为 https://yunwu.ai，可由 config.apiBase 覆盖
 */
export class YunwuAdaptiveProvider implements ImageProvider {
  readonly name = 'yunwu-adaptive'

  private readonly inner: ImageProvider
  private readonly apiFormat: YunwuApiFormat

  constructor(inner: ImageProvider, apiFormat: YunwuApiFormat) {
    this.inner = inner
    this.apiFormat = apiFormat
  }

  /** 内部委托对象的协议类型（用于诊断 / 路由） */
  getApiFormat(): YunwuApiFormat {
    return this.apiFormat
  }

  /** 暴露内部委托对象，便于上层进行类型守卫或调试日志 */
  getInner(): ImageProvider {
    return this.inner
  }

  generateImages(
    prompt: string,
    imageUrls: string | string[],
    numImages: number,
    options?: ImageGenerationOptions,
    onImageGenerated?: ImageGeneratedCallback
  ): Promise<string[]> {
    return this.inner.generateImages(prompt, imageUrls, numImages, options, onImageGenerated)
  }
}

/**
 * 工厂函数（注册表用）
 *
 * 期望 config 结构：
 * ```ts
 * {
 *   apiKey: string
 *   modelId: string
 *   apiBase?: string             // 默认 https://yunwu.ai
 *   apiFormat?: 'gemini' | 'openai'  // 默认 'gemini'
 *   apiTimeout: number
 *   logLevel?: ...
 * }
 * ```
 */
export function createYunwuAdaptiveProvider(
  ctx: Context,
  config: Record<string, unknown>
): YunwuAdaptiveProvider {
  const apiFormat = normalizeApiFormat(config.apiFormat)

  // 注入默认 apiBase（云雾），用户配置优先
  const innerConfig: Record<string, unknown> = {
    ...config,
    apiBase:
      typeof config.apiBase === 'string' && config.apiBase.length > 0
        ? config.apiBase
        : DEFAULT_API_BASE,
  }

  let inner: ImageProvider
  if (apiFormat === 'openai') {
    inner = withLoggerName(
      createOpenAIImagesProvider(ctx, innerConfig),
      'aka-ai-image-generator:yunwu-adaptive[openai]'
    )
  } else {
    inner = withLoggerName(
      createGeminiProvider(ctx, innerConfig),
      'aka-ai-image-generator:yunwu-adaptive[gemini]'
    )
  }

  return new YunwuAdaptiveProvider(inner, apiFormat)
}

/**
 * 解析 apiFormat 字段，未知值 fallback 为 'gemini'（与 v1 默认行为一致）
 */
function normalizeApiFormat(value: unknown): YunwuApiFormat {
  if (value === 'openai') return 'openai'
  return 'gemini'
}

/**
 * 注：`createOpenAIImagesProvider` / `createGeminiProvider` 内部已经按
 * 各自前缀创建了 logger，这里仅保留扩展点。当前实现不修改 logger，
 * 保持函数签名以便后续如需更细粒度日志区分时无需改动调用点。
 */
function withLoggerName<T extends ImageProvider>(provider: T, _name: string): T {
  return provider
}

/** 类型守卫：判断一个 ImageProvider 是否为 YunwuAdaptiveProvider */
export function isYunwuAdaptiveProvider(provider: ImageProvider): provider is YunwuAdaptiveProvider {
  return provider instanceof YunwuAdaptiveProvider
}

/** 重导出，方便上层无需直接 import 内部委托类型 */
export { GeminiProvider, OpenAIImagesProvider }
