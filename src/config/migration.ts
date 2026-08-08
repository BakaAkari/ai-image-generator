import type { Config } from '../shared/config.js'
import type { ModelMappingConfig } from '../shared/types.js'

export interface MigrationResult {
  config: Config
  migrated: boolean
  actions: string[]
}

/**
 * 配置迁移入口。目前处理：
 * - activeSupplier 旧值 yunwu/gptgod → newapi
 * - mapping.supplier / protocol / provider（历史字段）清理
 * - costMarkup（倍率）→ pricingMarkupPercent（百分比）
 * - supplierCreditToRmb（yunwu 残渣，0.5）→ usdToRmb（USD→CNY，默认 6.76）
 * - quotaPerUnit 旧错误默认 5000（单位误读修正前）→ 500000（NewAPI 标准，真实美元 = quota/500000）
 * - yunwuGroupRatio / yunwuGroup（历史全局倍率）→ 清理
 * - mapping.groupRatio（deprecated，改用 ratioOverride）→ 清理
 * - 其它遗留字段（creditExchangeRate / modelCostProbes / yunwuCreditToRmb / dailyFreeCredits）→ 清理
 */
export function migrateConfig(config: Config): MigrationResult {
  const actions: string[] = []
  let changed = false
  const clone = structuredClone(config)
  const mappings = (clone.modelMappings ?? []) as ModelMappingConfig[]

  // configMode: manual → simple（2.6.0 起只保留 auto / simple 双模式）
  // 旧配置运行时可能携带 manual（反序列化不受 TS 类型约束），按字符串判断。
  if ((clone.configMode as string | undefined) === 'manual') {
    clone.configMode = 'simple'
    actions.push('migrated configMode manual → simple')
    changed = true
  }

  // simple 模式下：为没有固定积分策略的映射补保守默认（1 积分/次），
  // 避免迁移后 simple 定价无法结算；已有 creditCostPerImage 保留。
  // 死字段 billingPolicy.fixed 的值迁移到 creditCostPerImage（保留用户显式定价，如 mj 0.1），
  // 然后删除 billingPolicy（结算层不消费该字段）。
  // auto 模式：不动映射字段（billingPolicy 可能是用户显式配置，由 config-autopilot 推导保留）。
  const DEFAULT_SIMPLE_CREDITS = 1
  if (clone.configMode === 'simple' || clone.configMode == null) {
    for (const mapping of mappings) {
      const raw = mapping as unknown as Record<string, unknown>
      if (raw.billingPolicy !== undefined) {
        const policy = raw.billingPolicy as { type?: string; creditsPerImage?: number }
        if (policy && policy.type === 'fixed' && typeof policy.creditsPerImage === 'number' && Number.isFinite(policy.creditsPerImage) && policy.creditsPerImage > 0) {
          if (typeof mapping.creditCostPerImage !== 'number' || !Number.isFinite(mapping.creditCostPerImage) || mapping.creditCostPerImage <= 0) {
            mapping.creditCostPerImage = policy.creditsPerImage
            actions.push(`simple mode: migrated billingPolicy.fixed=${policy.creditsPerImage} → creditCostPerImage for mapping ${mapping.suffix}`)
          }
        }
        delete raw.billingPolicy
        actions.push(`removed dead billingPolicy from mapping ${mapping.suffix}`)
        changed = true
      }
      if (typeof mapping.creditCostPerImage !== 'number' || !Number.isFinite(mapping.creditCostPerImage) || mapping.creditCostPerImage <= 0) {
        mapping.creditCostPerImage = DEFAULT_SIMPLE_CREDITS
        actions.push(`simple mode: set default creditCostPerImage=1 for mapping ${mapping.suffix}`)
        changed = true
      }
    }
  }

  // activeSupplier: yunwu/gptgod → newapi（new-api 兼容站统一标识）
  const rawActive = clone.activeSupplier as string | undefined
  if (rawActive === 'yunwu' || rawActive === 'gptgod') {
    clone.activeSupplier = 'newapi'
    actions.push(`migrated activeSupplier ${rawActive} → newapi`)
    changed = true
  }

  for (const mapping of mappings) {
    if (mapping.supplier) { delete mapping.supplier; actions.push('removed legacy supplier from mapping'); changed = true }
    if (mapping.protocol) { delete mapping.protocol; actions.push('removed legacy protocol from mapping'); changed = true }
    if (mapping.provider) { delete mapping.provider; actions.push('removed legacy provider from mapping'); changed = true }
  }

  // costMarkup（倍率）→ pricingMarkupPercent（百分比）
  if (typeof clone.pricingMarkupPercent !== 'number' || !Number.isFinite(clone.pricingMarkupPercent)) {
    if (typeof clone.costMarkup === 'number' && Number.isFinite(clone.costMarkup) && clone.costMarkup > 0) {
      clone.pricingMarkupPercent = Math.max(0, Math.round((clone.costMarkup - 1) * 100 * 100) / 100)
      actions.push(`migrated costMarkup ${clone.costMarkup} → pricingMarkupPercent ${clone.pricingMarkupPercent}`)
      changed = true
    }
  }

  // supplierCreditToRmb (yunwu 残渣，1 积分=¥0.5) → usdToRmb (USD→CNY, 默认 6.76 = 2026-08-06 快照)
  // 已有 usdToRmb → 尊重现值，只删旧字段；无 usdToRmb 时：
  //   - 旧值 === 0.5 或缺失/无效 → 写 usdToRmb = 6.76（默认修正）
  //   - 旧值为其他正数 → 视为用户自定义，直接搬到 usdToRmb
  if (typeof clone.usdToRmb !== 'number' || !Number.isFinite(clone.usdToRmb) || clone.usdToRmb <= 0) {
    const legacy = clone.supplierCreditToRmb
    if (typeof legacy === 'number' && Number.isFinite(legacy) && legacy > 0 && legacy !== 0.5) {
      clone.usdToRmb = legacy
      actions.push(`migrated supplierCreditToRmb ${legacy} → usdToRmb ${legacy} (custom value preserved)`)
    } else {
      clone.usdToRmb = 6.76
      actions.push(`migrated supplierCreditToRmb ${legacy ?? '(missing)'} → usdToRmb 6.76 (default corrected from yunwu residue)`)
    }
    changed = true
  }
  if ('supplierCreditToRmb' in clone) { delete clone.supplierCreditToRmb; actions.push('removed legacy supplierCreditToRmb'); changed = true }

  // quotaPerUnit：旧错误默认 5000（计费单位误读修正前，真实美元错误放大 100 倍）→ 500000（NewAPI 标准）。
  // 仅迁移已知错误值 5000；其它自定义值视为自建站非标 QuotaPerUnit，保留。
  if (typeof clone.quotaPerUnit === 'number' && clone.quotaPerUnit === 5000) {
    clone.quotaPerUnit = 500000
    actions.push('migrated quotaPerUnit 5000 → 500000 (legacy unit-misread default corrected)')
    changed = true
  }

  if ('costMarkup' in clone) { delete clone.costMarkup; actions.push('removed legacy costMarkup'); changed = true }
  if ('creditExchangeRate' in clone) { delete clone.creditExchangeRate; actions.push('removed legacy creditExchangeRate'); changed = true }
  if ('dailyFreeCredits' in clone) { delete clone.dailyFreeCredits; actions.push('removed legacy dailyFreeCredits'); changed = true }
  if ('modelCostProbes' in clone) { delete clone.modelCostProbes; actions.push('removed legacy modelCostProbes'); changed = true }
  if ('yunwuCreditToRmb' in clone) { delete clone.yunwuCreditToRmb; actions.push('removed legacy yunwuCreditToRmb'); changed = true }
  // 计费探测已移除；旧字段（probeApiBase / probeApiKey / probeRateLimit / probePrompt /
  // probeReserveMargin）在旧配置中可能残留，清理避免污染 settings.json。
  // 保留 logAccessApiKey / logAccessUserId（MJ 逐任务结算仍使用）。
  const PROBE_LEGACY_FIELDS = ['probeApiBase', 'probeApiKey', 'probeRateLimit', 'probePrompt', 'probeReserveMargin'] as const
  for (const field of PROBE_LEGACY_FIELDS) {
    if (field in (clone as unknown as Record<string, unknown>)) {
      delete (clone as unknown as Record<string, unknown>)[field]
      actions.push(`removed legacy ${field}`)
      changed = true
    }
  }

  if (mappings.length === 0) actions.push('modelMappings empty; explicit configuration required')
  if (clone.provider) { delete clone.provider; actions.push('removed legacy global provider field'); changed = true }

  // yunwuGroupRatio / yunwuGroup 迁移到 mapping.groupRatio
  let globalRatio: number | undefined
  if (typeof clone.yunwuGroupRatio === 'number' && Number.isFinite(clone.yunwuGroupRatio) && clone.yunwuGroupRatio > 0) {
    globalRatio = clone.yunwuGroupRatio
    actions.push(`read global yunwuGroupRatio=${globalRatio}`)
  } else if (typeof clone.yunwuGroup === 'string' && clone.yunwuGroup) {
    // yunwuGroup 字符串不在 migration 层有 catalog 信息，设为 1 等 catalog 解析时映射
    globalRatio = 1
    actions.push(`legacy yunwuGroup="${clone.yunwuGroup}" — will resolve via catalog at view-model time`)
  }
  if (globalRatio !== undefined) {
    for (const mapping of mappings) {
      if (mapping.groupRatio == null || typeof mapping.groupRatio !== 'number' || !Number.isFinite(mapping.groupRatio) || mapping.groupRatio <= 0) {
        (mapping as unknown as Record<string, unknown>).groupRatio = globalRatio
        actions.push(`set mapping ${mapping.suffix} groupRatio=${globalRatio} from global`)
      }
    }
  }
  // 清理旧字段（不报错，旧字段仍可存在于 JSON 中，interface 保留 @deprecated）
  if ('yunwuGroupRatio' in clone) { delete clone.yunwuGroupRatio; actions.push('removed legacy yunwuGroupRatio'); changed = true }
  if ('yunwuGroup' in clone) { delete clone.yunwuGroup; actions.push('removed legacy yunwuGroup'); changed = true }

  // mapping.groupRatio 已弃用（改用 ratioOverride）。逐条清理，不动 ratioOverride。
  for (const mapping of mappings) {
    if ('groupRatio' in (mapping as unknown as Record<string, unknown>)) {
      delete (mapping as unknown as Record<string, unknown>).groupRatio
      actions.push(`removed legacy mapping groupRatio from ${mapping.suffix}`)
      changed = true
    }
  }

  return { config: clone as Config, migrated: changed, actions }
}

export function sanitizeModelMapping(mapping: ModelMappingConfig): ModelMappingConfig {
  return {
    suffix: mapping.suffix,
    modelId: mapping.modelId,
    restricted: mapping.restricted,
    creditCostPerImage: mapping.creditCostPerImage,
  }
}
