import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { GLOBAL_RUNTIME_FIELDS, mergeConfig, mergeGlobalRuntimeFields, readConfig, writeConfig } from '../../src/console/config-store.js'
import type { Config } from '../../src/shared/config.js'

function baseConfig(): Config {
  return {
    activeSupplier: 'newapi',
    catalogRefreshHours: 6,
    pricingMarkupPercent: 30,
    usdToRmb: 6.76,
    trialImageLimit: 1,
    defaultCreditCostPerImage: 0.3,
    defaultNumImages: 1,
    logLevel: 'simple',
    apiTimeout: 60,
    rateLimitWindow: 300,
    rateLimitMax: 5,
    securityBlockWindow: 600,
    securityBlockWarningThreshold: 3,
    creditUnitName: '积分',
    showCreditCostInResult: true,
    showQuotaInImageCommands: true,
    creditsPerCny: 100,
    modelMappings: [],
    styles: [],
    adminUsers: [],
    permanentMembers: [],
    modelWhitelistUsers: [],
    unlimitedPlatforms: [],
    chatlunaEnabled: false,
    chatlunaContextInjectionEnabled: false,
    chatlunaExposeQuotaTool: false,
    chatlunaExposeStyleListTool: false,
    chatlunaContextHistorySize: 20,
    chatlunaContextTtlSeconds: 86400,
    chatlunaPreferLastGeneratedInPrivateRoom: true,
    yesimbotEnabled: false,
    yesimbotExposeQuotaTool: false,
    yesimbotExposeStyleListTool: false,
    providerSettings: {
      openaiCompatibleApiKey: 'secret',
      openaiCompatibleApiBase: 'https://api.openai.com/v1',
      openaiCompatibleExtraHeaders: { 'X-Existing': 'keep-me' },
    },
  } as unknown as Config
}

describe('aka-tools JSON config store', () => {
  it('loads settings.json over the koishi.yml bootstrap config', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'aka-config-'))
    const ctx = { baseDir } as any
    const dataDir = join(baseDir, 'data/aka-ai-image-generator')
    await import('node:fs/promises').then(fs => fs.mkdir(dataDir, { recursive: true }))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ trialImageLimit: 42, modelMappings: [{ suffix: 'new', modelId: 'gpt-image-2' }] }))

    const loaded = await readConfig(ctx, baseConfig())

    expect(loaded.trialImageLimit).toBe(42)
    // simple 模式迁移会为无固定积分的映射补默认 creditCostPerImage（1 积分/次）
    expect(loaded.modelMappings).toEqual([{ suffix: 'new', modelId: 'gpt-image-2', creditCostPerImage: 1 }])
    expect(loaded.providerSettings?.openaiCompatibleApiKey).toBe('secret')
  })

  it('preserves real secrets when the console sends masked placeholders', () => {
    const current = baseConfig()
    const next = mergeConfig(current, {
      providerSettings: { openaiCompatibleApiKey: 'sk-abc...xyz', openaiCompatibleApiBase: 'https://example.test/v1' },
    })

    expect(next.providerSettings?.openaiCompatibleApiKey).toBe('secret')
    expect(next.providerSettings?.openaiCompatibleApiBase).toBe('https://example.test/v1')
  })

  it('writes complete JSON atomically and can read it back', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'aka-config-'))
    const ctx = { baseDir } as any
    const saved = { ...baseConfig(), trialImageLimit: 77 }

    await writeConfig(ctx, saved)

    const raw = JSON.parse(await readFile(join(baseDir, 'data/aka-ai-image-generator/settings.json'), 'utf8'))
    expect(raw.trialImageLimit).toBe(77)
    expect(await readConfig(ctx, baseConfig())).toEqual(saved)
  })

  it('merges newly-panel-managed fields from the client payload', () => {
    const current = baseConfig()
    const next = mergeConfig(current, {
      showQuotaInImageCommands: false,
      securityBlockWindow: 900,
      securityBlockWarningThreshold: 5,
      chatlunaContextHistorySize: 42,
      chatlunaContextTtlSeconds: 7200,
      chatlunaPreferLastGeneratedInPrivateRoom: false,
    } as Partial<Config>)

    expect(next.showQuotaInImageCommands).toBe(false)
    expect(next.securityBlockWindow).toBe(900)
    expect(next.securityBlockWarningThreshold).toBe(5)
    expect(next.chatlunaContextHistorySize).toBe(42)
    expect(next.chatlunaContextTtlSeconds).toBe(7200)
    expect(next.chatlunaPreferLastGeneratedInPrivateRoom).toBe(false)
  })

  it('replaces extra headers with the incoming panel value', () => {
    const current = baseConfig()
    const next = mergeConfig(current, {
      providerSettings: {
        openaiCompatibleApiKey: '***',
        openaiCompatibleExtraHeaders: { 'X-New': 'value' },
      } as Config['providerSettings'],
    })

    expect(next.providerSettings?.openaiCompatibleApiKey).toBe('secret')
    expect(next.providerSettings?.openaiCompatibleExtraHeaders).toEqual({ 'X-New': 'value' })
  })

  it('pins global runtime fields to the koishi bootstrap on restart, even when settings.json holds older values', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'aka-config-'))
    const ctx = { baseDir } as any
    const dataDir = join(baseDir, 'data/aka-ai-image-generator')
    await import('node:fs/promises').then(fs => fs.mkdir(dataDir, { recursive: true }))
    await writeFile(
      join(dataDir, 'settings.json'),
      JSON.stringify({
        apiTimeout: 999,
        catalogRefreshHours: 72,
        logLevel: 'detail',
        trialImageLimit: 42,
      }),
    )

    const bootstrap = { ...baseConfig(), apiTimeout: 45, catalogRefreshHours: 3, logLevel: 'simple' } as Config
    const loaded = await readConfig(ctx, bootstrap)

    expect(loaded.apiTimeout).toBe(45)
    expect(loaded.catalogRefreshHours).toBe(3)
    expect(loaded.logLevel).toBe('simple')
    expect(loaded.trialImageLimit).toBe(42)
  })

  it('drops incoming global runtime fields from the aka-tools payload so they cannot overwrite current values', () => {
    const current = { ...baseConfig(), apiTimeout: 45, catalogRefreshHours: 3, logLevel: 'simple' } as Config
    const next = mergeConfig(current, {
      apiTimeout: 999,
      catalogRefreshHours: 72,
      logLevel: 'detail',
      trialImageLimit: 88,
    } as Partial<Config>)

    expect(next.apiTimeout).toBe(45)
    expect(next.catalogRefreshHours).toBe(3)
    expect(next.logLevel).toBe('simple')
    expect(next.trialImageLimit).toBe(88)
  })

  it('keeps business fields saved-wins even when global fields exist in bootstrap', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'aka-config-'))
    const ctx = { baseDir } as any
    const dataDir = join(baseDir, 'data/aka-ai-image-generator')
    await import('node:fs/promises').then(fs => fs.mkdir(dataDir, { recursive: true }))
    await writeFile(
      join(dataDir, 'settings.json'),
      JSON.stringify({
        trialImageLimit: 42,
        chatlunaContextHistorySize: 77,
      }),
    )

    const bootstrap = { ...baseConfig(), trialImageLimit: 1, chatlunaContextHistorySize: 20 } as Config
    const loaded = await readConfig(ctx, bootstrap)

    expect(loaded.trialImageLimit).toBe(42)
    expect(loaded.chatlunaContextHistorySize).toBe(77)
  })

  it('exports GLOBAL_RUNTIME_FIELDS as the exact set of Koishi-managed fields', () => {
    expect([...GLOBAL_RUNTIME_FIELDS].sort()).toEqual(['apiTimeout', 'catalogRefreshHours', 'logLevel'])
  })

  describe('mergeGlobalRuntimeFields (Koishi Config page ownership boundary)', () => {
    it('only updates the three global runtime fields, ignoring incoming business defaults', () => {
      const current = {
        ...baseConfig(),
        apiTimeout: 45,
        catalogRefreshHours: 3,
        logLevel: 'simple',
        trialImageLimit: 42,
        modelMappings: [{ suffix: 'saved', modelId: 'm-1' }],
      } as Config
      const incoming = {
        apiTimeout: 90,
        catalogRefreshHours: 12,
        logLevel: 'detail',
        trialImageLimit: 1,
        modelMappings: [],
        chatlunaContextHistorySize: 999,
        providerSettings: { openaiCompatibleApiKey: 'stomp' },
      } as unknown as Config
      const next = mergeGlobalRuntimeFields(current, incoming)

      expect(next.apiTimeout).toBe(90)
      expect(next.catalogRefreshHours).toBe(12)
      expect(next.logLevel).toBe('detail')
      expect(next.trialImageLimit).toBe(42)
      expect(next.modelMappings).toEqual([{ suffix: 'saved', modelId: 'm-1' }])
      expect(next.chatlunaContextHistorySize).toBe(current.chatlunaContextHistorySize)
      expect(next.providerSettings?.openaiCompatibleApiKey).toBe('secret')
    })

    it('leaves current global values untouched when incoming omits the fields', () => {
      const current = {
        ...baseConfig(),
        apiTimeout: 45,
        catalogRefreshHours: 3,
        logLevel: 'simple',
      } as Config
      const next = mergeGlobalRuntimeFields(current, { trialImageLimit: 7 } as Partial<Config>)

      expect(next.apiTimeout).toBe(45)
      expect(next.catalogRefreshHours).toBe(3)
      expect(next.logLevel).toBe('simple')
      expect(next.trialImageLimit).toBe(current.trialImageLimit)
    })

    it('leaves current global values untouched when incoming explicitly sends undefined', () => {
      const current = { ...baseConfig(), apiTimeout: 45, catalogRefreshHours: 3, logLevel: 'simple' } as Config
      const incoming = { apiTimeout: undefined, catalogRefreshHours: undefined, logLevel: undefined } as Partial<Config>
      const next = mergeGlobalRuntimeFields(current, incoming)

      expect(next.apiTimeout).toBe(45)
      expect(next.catalogRefreshHours).toBe(3)
      expect(next.logLevel).toBe('simple')
    })

    it('accepts partial updates: only the field that changed moves', () => {
      const current = { ...baseConfig(), apiTimeout: 45, catalogRefreshHours: 3, logLevel: 'simple' } as Config
      const next = mergeGlobalRuntimeFields(current, { catalogRefreshHours: 8 } as Partial<Config>)

      expect(next.apiTimeout).toBe(45)
      expect(next.catalogRefreshHours).toBe(8)
      expect(next.logLevel).toBe('simple')
    })

    it('does not mutate the current config in place', () => {
      const current = { ...baseConfig(), apiTimeout: 45 } as Config
      const snapshot = JSON.parse(JSON.stringify(current))
      mergeGlobalRuntimeFields(current, { apiTimeout: 999, trialImageLimit: 1 } as Partial<Config>)
      expect(current).toEqual(snapshot)
    })
  })
})
