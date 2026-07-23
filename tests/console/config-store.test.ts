import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { mergeConfig, readConfig, writeConfig } from '../../src/console/config-store.js'
import type { Config } from '../../src/shared/config.js'

function baseConfig(): Config {
  return {
    activeSupplier: 'yunwu',
    catalogRefreshHours: 6,
    creditExchangeRate: 1000,
    costMarkup: 1.3,
    yunwuCreditToRmb: 0.5,
    dailyFreeCredits: 1,
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
    showEstimatedCny: false,
    minRechargeCredits: 0,
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
      openaiCompatibleApiBase: 'https://yunwu.ai/v1',
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
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ dailyFreeCredits: 42, modelMappings: [{ suffix: 'new', modelId: 'gpt-image-2' }] }))

    const loaded = await readConfig(ctx, baseConfig())

    expect(loaded.dailyFreeCredits).toBe(42)
    expect(loaded.modelMappings).toEqual([{ suffix: 'new', modelId: 'gpt-image-2' }])
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
    const saved = { ...baseConfig(), dailyFreeCredits: 77 }

    await writeConfig(ctx, saved)

    const raw = JSON.parse(await readFile(join(baseDir, 'data/aka-ai-image-generator/settings.json'), 'utf8'))
    expect(raw.dailyFreeCredits).toBe(77)
    expect(await readConfig(ctx, baseConfig())).toEqual(saved)
  })

  it('merges newly-panel-managed fields from the client payload', () => {
    const current = baseConfig()
    const next = mergeConfig(current, {
      showQuotaInImageCommands: false,
      showEstimatedCny: true,
      minRechargeCredits: 12,
      securityBlockWindow: 900,
      securityBlockWarningThreshold: 5,
      chatlunaContextHistorySize: 42,
      chatlunaContextTtlSeconds: 7200,
      chatlunaPreferLastGeneratedInPrivateRoom: false,
    } as Partial<Config>)

    expect(next.showQuotaInImageCommands).toBe(false)
    expect(next.showEstimatedCny).toBe(true)
    expect(next.minRechargeCredits).toBe(12)
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
})
