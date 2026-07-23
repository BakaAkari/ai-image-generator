import type { Context } from 'koishi'
import { promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'

import type { Config, ProviderSettingsConfig } from '../shared/config.js'

const SETTINGS_RELATIVE_PATH = 'data/aka-ai-image-generator/settings.json'
const SECRET_FIELDS = [
  'openaiCompatibleApiKey',
  'gptOfficialApiKey',
  'geminiOfficialApiKey',
] as const

type SecretField = typeof SECRET_FIELDS[number]

export function getConfigPath(ctx: Pick<Context, 'baseDir'>): string {
  return resolve(ctx.baseDir, SETTINGS_RELATIVE_PATH)
}

export async function readConfig(ctx: Pick<Context, 'baseDir'>, bootstrapConfig: Config): Promise<Config> {
  try {
    const raw = await fs.readFile(getConfigPath(ctx), 'utf8')
    const saved = JSON.parse(raw) as Partial<Config>
    return mergeConfig(bootstrapConfig, saved)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    const initial = cloneConfig(bootstrapConfig)
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

export function mergeConfig(current: Config, incoming: Partial<Config>): Config {
  const next = {
    ...cloneConfig(current),
    ...cloneConfig(incoming),
    providerSettings: mergeProviderSettings(current.providerSettings, incoming.providerSettings),
  } as Config

  for (const field of SECRET_FIELDS) {
    const incomingValue = incoming[field]
    if (isMaskedSecret(incomingValue)) next[field] = current[field]
  }
  return next
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
