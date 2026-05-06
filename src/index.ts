import { Context, Schema } from 'koishi'

import { createOpenAIImagesProvider } from './providers/openai-images.js'
import { ProviderRegistry } from './providers/registry.js'
import type { Config as PluginConfig } from './shared/config.js'
import { PLUGIN_NAME } from './shared/constants.js'

/**
 * V2 插件入口（aka-ai-image-generator）
 *
 * Phase 2：完成 Provider 基础设施
 *   - ProviderRegistry：统一 Provider 注册中心
 *   - OpenAIImagesProvider：第一个落地 Provider，验证 BaseImageProvider 设计
 *
 * 后续阶段会在此处接入：
 *   - Phase 3：Schema 终态 + 全部 Provider（gemini / gptgod / yunwu / official-gpt）
 *   - Phase 4：UserManager / AiImageGeneratorService / Orchestrators / 命令族
 *   - Phase 5：迁移工具 + 文档 + 发布
 *
 * Phase 3 会用 Tagged Union 重写 `Config` 为完整 Schema，并替换下面的占位。
 */
export const name = PLUGIN_NAME

// 暴露给 Koishi 的配置类型；与 shared/config.ts 中的运行期 interface 对齐
export type Config = PluginConfig

// Phase 2 占位 Schema：保持插件可加载，避免 Koishi 控制台报错
// Phase 3 替换为基于 Tagged Union 的完整 Schema 设计（详见 v2 架构文档 §13）
export const Config: Schema<Config> = Schema.object({}) as Schema<Config>

// 模块级注册表实例（生命周期与插件模块一致）
// 设计取舍：
//   - 注册表本身无状态（只持有工厂引用），多次 apply 不会造成内存泄漏
//   - 通过 createProvider() 即时构造 Provider 实例，由 Service 层决定缓存策略
//   - 暴露在模块作用域便于 Phase 3 的 Provider 子模块在 import 期完成自注册
const providerRegistry = new ProviderRegistry()

// 内置 Provider 注册（Phase 2 仅 openai-images，Phase 3 会补齐其余）
providerRegistry.register('openai-images', createOpenAIImagesProvider)

/**
 * 暴露给同插件其它模块（如未来的 Service / Orchestrator）的注册表入口。
 * 不通过 ctx.set() 暴露，避免污染全局服务命名空间。
 */
export function getProviderRegistry(): ProviderRegistry {
  return providerRegistry
}

export function apply(ctx: Context, _config: Config) {
  const logger = ctx.logger(name)
  const registered = providerRegistry.list()
  logger.info(
    'plugin=%s phase=2 status=infrastructure-ready providers=%s count=%d',
    name,
    registered.join(',') || '<none>',
    registered.length
  )
}
