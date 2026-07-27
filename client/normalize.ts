/**
 * aka-tools 面板配置归一化辅助。
 *
 * 抽出为独立模块便于合同测试直接引用：面板必须在保存前把默认值补齐并
 * 强制规范化 openaiCompatibleExtraHeaders，避免把 undefined 或非法值写回
 * settings.json。
 */

export function sanitizeHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : ''
    if (!key) continue
    if (rawValue == null) continue
    const value = String(rawValue)
    if (!value) continue
    out[key] = value
  }
  return out
}

export function objectToRows(raw: unknown): Array<{ key: string; value: string }> {
  const clean = sanitizeHeaders(raw)
  return Object.entries(clean).map(([key, value]) => ({ key, value }))
}

export function rowsToObject(rows: Array<{ key: string; value: string }>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    if (row.value == null) continue
    const value = String(row.value)
    if (!value) continue
    out[key] = value
  }
  return out
}

/**
 * 深拷贝并防御脏 styleGroups：
 * - 非对象/数组 → {}
 * - 每个 entry：key 必须是非空字符串；value 必须是对象
 * - prompts 非数组 → []
 * - 每个 preset 复制为独立对象，避免 v-model 直接改到远端引用
 */
export function normalizeStyleGroups(raw: unknown): Record<string, { prompts: any[] }> {
  const out: Record<string, { prompts: any[] }> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : ''
    if (!key) continue
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) continue
    const rawPrompts = (rawValue as { prompts?: unknown }).prompts
    const prompts = Array.isArray(rawPrompts)
      ? rawPrompts
          .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
          .map((item) => ({ ...item }))
      : []
    out[key] = { prompts }
  }
  return out
}

/**
 * Merge raw remote config with client-side defaults for every user-editable
 * field. Any field absent from `raw` is filled in so v-model bindings never
 * hit `undefined` and saves cannot silently drop fields.
 */
export function normalizeConfig(raw: any): any {
  const source = raw && typeof raw === 'object' ? raw : {}
  const c: any = { ...source }
  c.setupGuide = source.setupGuide ?? ''
  const rawHeaders = source.providerSettings?.openaiCompatibleExtraHeaders
  c.providerSettings = {
    openaiCompatibleApiKey: source.openaiCompatibleApiKey ?? '',
    openaiCompatibleApiBase: source.providerSettings?.openaiCompatibleApiBase ?? '',
    gptOfficialApiKey: source.gptOfficialApiKey ?? '',
    geminiOfficialApiKey: source.geminiOfficialApiKey ?? '',
    openaiCompatibleExtraHeaders: sanitizeHeaders(rawHeaders),
  }
  c.activeSupplier ??= 'yunwu'
  // 定价字段：pricingMarkupPercent 从旧 costMarkup 迁移（1.3→30）；creditsPerCny 保持已存值
  // 或用 10 作为兜底默认，不主动覆盖本地已有值。creditExchangeRate 仅作旧配置读取。
  if (typeof c.pricingMarkupPercent !== 'number' || !Number.isFinite(c.pricingMarkupPercent)) {
    if (typeof c.costMarkup === 'number' && Number.isFinite(c.costMarkup) && c.costMarkup > 0) {
      c.pricingMarkupPercent = Math.max(0, Math.round((c.costMarkup - 1) * 100 * 100) / 100)
    } else {
      c.pricingMarkupPercent = 30
    }
  }
  delete c.creditExchangeRate
  delete c.costMarkup
  if (typeof c.creditsPerCny !== 'number' || !Number.isFinite(c.creditsPerCny) || c.creditsPerCny <= 0) {
    c.creditsPerCny = 10
  }
  // yunwu 分组倍率：默认 1（default 分组）。旧字符串 yunwuGroup 只用于后端一次性
  // 数字化迁移，面板不再暴露、也不需要在此重新合成默认值。
  delete c.yunwuGroupRatio
  delete c.yunwuGroup
  c.creditUnitName ??= '积分'
  c.trialImageLimit ??= 3
  c.freeTrialModelId ??= ''
  c.freePlatforms ??= ['lark']
  c.showCreditCostInResult ??= true
  c.showQuotaInImageCommands ??= true
  c.rateLimitWindow ??= 300
  c.rateLimitMax ??= 3
  c.securityBlockWindow ??= 600
  c.securityBlockWarningThreshold ??= 3
  c.defaultNumImages ??= 1
  c.chatlunaEnabled ??= false
  c.chatlunaContextInjectionEnabled ??= true
  c.chatlunaExposeQuotaTool ??= true
  c.chatlunaExposeStyleListTool ??= true
  c.chatlunaContextHistorySize ??= 20
  c.chatlunaContextTtlSeconds ??= 86400
  c.chatlunaPreferLastGeneratedInPrivateRoom ??= true
  c.yesimbotEnabled ??= false
  c.yesimbotExposeQuotaTool ??= true
  c.yesimbotExposeStyleListTool ??= true
  // 模型映射分组倍率：默认 1
  c.modelMappings = Array.isArray(source.modelMappings) ? source.modelMappings.map((m: any) => {
    const copy = { ...m }
    if (typeof copy.groupRatio !== 'number' || !Number.isFinite(copy.groupRatio) || copy.groupRatio <= 0) {
      copy.groupRatio = 1
    }
    return copy
  }) : []
  // modelCostProbes is no longer used by the panel after probe removal
  c.styles = Array.isArray(source.styles)
    ? source.styles
        .filter((s: unknown): s is Record<string, unknown> => !!s && typeof s === 'object' && !Array.isArray(s))
        .map((s: Record<string, unknown>) => ({ ...s }))
    : []
  c.styleGroups = normalizeStyleGroups(source.styleGroups)
  for (const key of ['adminUsers', 'permanentMembers', 'modelWhitelistUsers']) {
    c[key] = Array.isArray(source[key]) ? [...source[key]] : []
  }
  return c
}

/**
 * Field ids from `Config` (shared/config.ts) that this panel is contractually
 * responsible for surfacing. Deprecated / legacy flat fields intentionally
 * omitted; runtime still reads them but the panel does not expose them.
 */
export const USER_EDITABLE_FIELDS = [
  'setupGuide',
  'activeSupplier',
  'pricingMarkupPercent',
  'providerSettings',
  'styles',
  'styleGroups',
  'showQuotaInImageCommands',
  'defaultNumImages',
  'modelMappings',
  'creditUnitName',
  'trialImageLimit',
  'freeTrialModelId',
  'freePlatforms',
  'showCreditCostInResult',
  'creditsPerCny',
  'rateLimitWindow',
  'rateLimitMax',
  'securityBlockWindow',
  'securityBlockWarningThreshold',
  'adminUsers',
  'permanentMembers',
  'modelWhitelistUsers',
  'chatlunaEnabled',
  'chatlunaContextInjectionEnabled',
  'chatlunaExposeQuotaTool',
  'chatlunaExposeStyleListTool',
  'chatlunaContextHistorySize',
  'chatlunaContextTtlSeconds',
  'chatlunaPreferLastGeneratedInPrivateRoom',
  'yesimbotEnabled',
  'yesimbotExposeQuotaTool',
  'yesimbotExposeStyleListTool',
] as const

/**
 * 全局运行项：apiTimeout / catalogRefreshHours / logLevel 由 Koishi 原插件设置页
 * 独占管理，aka-tools 不再绑定这些字段。normalizeConfig 通过 `{ ...source }`
 * 透传，保证从面板保存的 payload 里保留当前运行值，避免 mergeConfig 后覆盖。
 */
export const GLOBAL_RUNTIME_FIELDS = [
  'apiTimeout',
  'catalogRefreshHours',
  'logLevel',
] as const

export const PROVIDER_SETTINGS_FIELDS = [
  'openaiCompatibleApiKey',
  'openaiCompatibleApiBase',
  'openaiCompatibleExtraHeaders',
  'gptOfficialApiKey',
  'geminiOfficialApiKey',
] as const

/**
 * Deprecated / legacy runtime-only fields the panel must NOT expose as
 * editable. Kept here so tests can assert exclusion.
 */
export const LEGACY_FIELDS = [
  'provider',
  'defaultCreditCostPerImage',
  'openaiCompatibleApiKey',
  'openaiCompatibleApiBase',
  'openaiCompatibleExtraHeaders',
  'gptOfficialApiKey',
  'geminiOfficialApiKey',
  'yunwuGroup',
  'yunwuCreditToRmb',
  'creditExchangeRate',
  'costMarkup',
] as const
