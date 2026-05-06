import type { Context } from 'koishi'

import { OpenAIImagesProvider } from './openai-images.js'
import type { BaseProviderOptions } from './types.js'

/**
 * OpenAI 官方 API 默认 base
 *
 * 与 v1 行为不同：v1 没有专门的 gpt-official Provider，
 * v2 新增此子类用于明确区分官方与第三方代理通道。
 */
const DEFAULT_API_BASE = 'https://api.openai.com/v1'

/**
 * 官方 OpenAI gpt-image 默认模型 ID
 */
const DEFAULT_MODEL_ID = 'gpt-image-1'

/**
 * GptOfficialProvider（v2 新增）
 *
 * 使用 OpenAI 官方 API 调用 gpt-image-1 / gpt-image-2 等模型。
 *
 * 行为上与 OpenAIImagesProvider 完全一致 —— 仅覆盖 `name` 用于日志区分，
 * 并提供官方 API 默认地址。所有协议细节、错误归一化、超时下限保护
 * 均继承自父类。
 */
export class GptOfficialProvider extends OpenAIImagesProvider {
  override readonly name = 'gpt-official'
}

/**
 * 工厂函数（注册表用）
 *
 * 期望 config 结构：
 * ```ts
 * {
 *   apiKey: string
 *   modelId?: string             // 默认 'gpt-image-1'
 *   apiBase?: string             // 默认 'https://api.openai.com/v1'
 *   apiTimeout: number
 *   logLevel?: ...
 * }
 * ```
 */
export function createGptOfficialProvider(
  ctx: Context,
  config: Record<string, unknown>
): GptOfficialProvider {
  return new GptOfficialProvider({
    ctx,
    apiKey: String(config.apiKey ?? ''),
    modelId: String(config.modelId ?? DEFAULT_MODEL_ID),
    apiBase:
      typeof config.apiBase === 'string' && config.apiBase.length > 0
        ? config.apiBase
        : DEFAULT_API_BASE,
    apiTimeout: Number.isFinite(config.apiTimeout as number) ? Number(config.apiTimeout) : 60,
    logLevel: config.logLevel as BaseProviderOptions['logLevel'],
    loggerName: 'aka-ai-image-generator:gpt-official',
  })
}
