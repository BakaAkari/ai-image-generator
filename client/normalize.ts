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
    openaiCompatibleApiKey: source.providerSettings?.openaiCompatibleApiKey ?? '',
    openaiCompatibleApiBase: source.providerSettings?.openaiCompatibleApiBase ?? '',
    gptOfficialApiKey: source.providerSettings?.gptOfficialApiKey ?? '',
    geminiOfficialApiKey: source.providerSettings?.geminiOfficialApiKey ?? '',
    openaiCompatibleExtraHeaders: sanitizeHeaders(rawHeaders),
  }
  c.activeSupplier ??= 'yunwu'
  c.catalogRefreshHours ??= 6
  c.creditExchangeRate ??= 1000
  c.costMarkup ??= 1.3
  c.yunwuCreditToRmb ??= 0.5
  c.yunwuGroup ??= 'default'
  c.creditUnitName ??= '积分'
  c.dailyFreeCredits ??= 5
  c.showCreditCostInResult ??= true
  c.showQuotaInImageCommands ??= true
  c.showEstimatedCny ??= false
  c.minRechargeCredits ??= 0
  c.creditsPerCny ??= 0
  c.rateLimitWindow ??= 300
  c.rateLimitMax ??= 3
  c.securityBlockWindow ??= 600
  c.securityBlockWarningThreshold ??= 3
  c.logLevel ??= 'simple'
  c.defaultNumImages ??= 1
  c.apiTimeout ??= 60
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
  c.modelMappings = Array.isArray(source.modelMappings) ? source.modelMappings.map((m: any) => ({
    ...m,
    chargePolicy: m?.chargePolicy ?? { type: 'disabled', reason: 'pricing unavailable' },
  })) : []
  c.styles = Array.isArray(source.styles) ? source.styles.map((s: any) => ({ ...s })) : []
  c.styleGroups = source.styleGroups && typeof source.styleGroups === 'object'
    ? JSON.parse(JSON.stringify(source.styleGroups))
    : {}
  for (const key of ['adminUsers', 'permanentMembers', 'modelWhitelistUsers', 'unlimitedPlatforms']) {
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
  'catalogRefreshHours',
  'creditExchangeRate',
  'costMarkup',
  'yunwuCreditToRmb',
  'yunwuGroup',
  'providerSettings',
  'styles',
  'styleGroups',
  'showQuotaInImageCommands',
  'defaultNumImages',
  'modelMappings',
  'creditUnitName',
  'dailyFreeCredits',
  'showCreditCostInResult',
  'creditsPerCny',
  'showEstimatedCny',
  'minRechargeCredits',
  'unlimitedPlatforms',
  'rateLimitWindow',
  'rateLimitMax',
  'securityBlockWindow',
  'securityBlockWarningThreshold',
  'adminUsers',
  'permanentMembers',
  'modelWhitelistUsers',
  'logLevel',
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
  'apiTimeout',
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
] as const
