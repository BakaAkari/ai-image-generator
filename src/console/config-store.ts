import type { Context } from 'koishi'
import { promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'

import type { Config, ProviderSettingsConfig } from '../shared/config.js'
import { migrateConfig } from '../config/migration.js'

const SETTINGS_RELATIVE_PATH = 'data/aka-ai-image-generator/settings.json'
const SECRET_FIELDS = [
  'openaiCompatibleApiKey',
  'gptOfficialApiKey',
  'geminiOfficialApiKey',
] as const

/**
 * Fields owned exclusively by the Koishi plugin config page (GlobalRuntimeSchema in
 * shared/config.ts). The aka-tools panel must not surface or overwrite them:
 *   - On restart, bootstrapConfig from Koishi wins over any value persisted in
 *     settings.json (Koishi Config Schema is the source of truth).
 *   - Any incoming payload from the console listener is stripped of these fields
 *     before merging so a stale UI or hand-crafted request cannot overwrite the
 *     currently running values.
 */
export const GLOBAL_RUNTIME_FIELDS = [
  'apiTimeout',
  'catalogRefreshHours',
  'logLevel',
] as const

type GlobalRuntimeField = typeof GLOBAL_RUNTIME_FIELDS[number]

export function getConfigPath(ctx: Pick<Context, 'baseDir'>): string {
  return resolve(ctx.baseDir, SETTINGS_RELATIVE_PATH)
}

export async function readConfig(ctx: Pick<Context, 'baseDir'>, bootstrapConfig: Config): Promise<Config> {
  try {
    const raw = await fs.readFile(getConfigPath(ctx), 'utf8')
    const saved = JSON.parse(raw) as Partial<Config>
    const migration = migrateConfig(mergeSavedWithBootstrap(bootstrapConfig, saved))
    if (migration.migrated) await writeConfig(ctx, migration.config)
    return migration.config
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    const initial = migrateConfig(cloneConfig(bootstrapConfig)).config
    await writeConfig(ctx, initial)
    return initial
  }
}

export async function writeConfig(ctx: Pick<Context, 'baseDir'>, config: Config): Promise<void> {
  const target = getConfigPath(ctx)
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`
  await fs.mkdir(dirname(target), { recursive: true })
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}
`, 'utf8')
  await fs.rename(temporary, target)
}

/**
 * Merge only the Koishi-owned global runtime fields from `incoming` into
 * `current`. Business fields in `incoming` are ignored — the Koishi Config
 * page must not overwrite settings.json-owned state even if its payload
 * contains defaulted business values. Missing global fields in `incoming`
 * leave the current value untouched (defaults never re-appear as clears).
 */
export function mergeGlobalRuntimeFields(current: Config, incoming: Partial<Config>): Config {
  const next = { ...current } as Config
  for (const field of GLOBAL_RUNTIME_FIELDS) {
    const value = (incoming ?? {} as Partial<Config>)[field as GlobalRuntimeField]
    if (value !== undefined) (next as any)[field] = value
  }
  return next
}

/**
 * Merge an aka-tools save payload into the currently running config.
 * Business fields are saved-wins. Global runtime fields are stripped from the
 * incoming payload so the console cannot overwrite Koishi-managed values even
 * if an older client or hand-crafted request includes them.
 */
export function mergeConfig(current: Config, incoming: Partial<Config>): Config {
  const filtered = stripGlobalRuntimeFields(incoming)
  const next = {
    ...cloneConfig(current),
    ...cloneConfig(filtered),
    providerSettings: mergeProviderSettings(current.providerSettings, filtered.providerSettings),
  } as Config

  for (const field of SECRET_FIELDS) {
    const incomingValue = filtered[field]
    if (isMaskedSecret(incomingValue)) next[field] = current[field]
  }
  return next
}

/**
 * Startup merge: business fields fall back to saved settings.json, but the
 * three global runtime fields are pinned to bootstrapConfig (Koishi Config
 * page). This ensures a change made in koishi.yml or the Koishi Config UI is
 * honoured on the next restart even if settings.json holds an older value.
 */
function mergeSavedWithBootstrap(bootstrap: Config, saved: Partial<Config>): Config {
  const savedBusiness = stripGlobalRuntimeFields(saved)
  const next = {
    ...cloneConfig(bootstrap),
    ...cloneConfig(savedBusiness),
    providerSettings: mergeProviderSettings(bootstrap.providerSettings, savedBusiness.providerSettings),
  } as Config

  for (const field of GLOBAL_RUNTIME_FIELDS) {
    const bootstrapValue = bootstrap[field as GlobalRuntimeField]
    if (bootstrapValue !== undefined) (next as any)[field] = bootstrapValue
    else delete (next as any)[field]
  }

  for (const field of SECRET_FIELDS) {
    const incomingValue = savedBusiness[field]
    if (isMaskedSecret(incomingValue)) next[field] = bootstrap[field]
  }
  return next
}

function stripGlobalRuntimeFields(incoming: Partial<Config>): Partial<Config> {
  const clone = { ...(incoming ?? {}) } as Partial<Config>
  for (const field of GLOBAL_RUNTIME_FIELDS) {
    delete (clone as any)[field]
  }
  return clone
}

function mergeProviderSettings(
  current: ProviderSettingsConfig | undefined,
  incoming: ProviderSettingsConfig | undefined,
): ProviderSettingsConfig | undefined {
  if (!current && !incoming) return undefined
  const next: ProviderSettingsConfig = { ...cloneConfig(current ?? {}), ...cloneConfig(incoming ?? {}) }
  for (const field of SECRET_FIELDS) {
    const incomingValue = incoming?.[field]
    if (isMaskedSecret(incomingValue)) next[field] = current?.[field]
  }
  return next
}

export function isMaskedSecret(value: unknown): value is string {
  if (typeof value !== 'string') return false
  return value === '***' || value.includes('...') || /^\*+$/.test(value)
}

function cloneConfig<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}
