/**
 * effective-mode：定价模式运行时判定（2.6.0）。
 *
 * configMode 存储管理员意图（auto / simple），运行期实际生效模式由
 * resolveEffectiveMode 决定：
 * - 手动选择 simple → 恒 simple（意图优先）。
 * - 意图 auto，但凭据缺失 / 目录刷新失败 → fallback simple（UI 提示，不改写配置）。
 * - 意图 auto 且凭据可用、目录正常 → auto。
 *
 * 纯函数，无副作用，便于单元测试。
 */
import type { Config } from './config.js'

export type ConfigMode = 'auto' | 'simple'

/** 凭据是否已配置：按激活供应商读取对应 API Key，非空即视为已配置。 */
export function hasSupplierCredential(config: Config): boolean {
  const active = config.activeSupplier ?? 'newapi'
  const s = config.providerSettings ?? {}
  const key =
    active === 'openai-official'
      ? s.gptOfficialApiKey
      : active === 'gemini-official'
        ? s.geminiOfficialApiKey
        : s.openaiCompatibleApiKey
  return typeof key === 'string' && key.trim().length > 0
}

export interface EffectiveModeResult {
  mode: ConfigMode
  /** fallback 原因（仅 fallback 时存在）：'no-credential' | 'catalog-failed'。 */
  fallbackReason?: 'no-credential' | 'catalog-failed'
}

/**
 * 解析实际生效模式。
 * @param config 当前配置（含 configMode 意图）
 * @param catalogOk 目录快照是否可用（models 非空且无 error）；未知时传 true 避免误 fallback
 */
export function resolveEffectiveMode(
  config: Config,
  catalogOk = true,
): EffectiveModeResult {
  const intent = config.configMode ?? 'simple'
  if (intent === 'simple') return { mode: 'simple' }
  if (!hasSupplierCredential(config)) return { mode: 'simple', fallbackReason: 'no-credential' }
  if (!catalogOk) return { mode: 'simple', fallbackReason: 'catalog-failed' }
  return { mode: 'auto' }
}
