import { copyFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CatalogSnapshot } from './model-catalog.js'

export interface CatalogCacheEnvelope<TCatalog = CatalogSnapshot> {
  schemaVersion: number
  parserVersion: string
  keyScopeFingerprint: string
  savedAt: number
  catalog: TCatalog
}

export interface LoadedCatalogCache<TCatalog = CatalogSnapshot> {
  envelope: CatalogCacheEnvelope<TCatalog>
  stale: boolean
  ageMs: number
}

export interface CatalogFileRepositoryOptions {
  now?: () => number
  maxAgeMs?: number
}

export class CatalogFileRepository<TCatalog = CatalogSnapshot> {
  private readonly now: () => number
  private readonly maxAgeMs: number

  constructor(
    private readonly finalPath: string,
    options: CatalogFileRepositoryOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.maxAgeMs = options.maxAgeMs ?? Number.POSITIVE_INFINITY
  }

  async load(keyScopeFingerprint: string): Promise<LoadedCatalogCache<TCatalog> | null> {
    return await this.loadPath(this.finalPath, keyScopeFingerprint)
      ?? await this.loadPath(`${this.finalPath}.bak`, keyScopeFingerprint)
  }

  private async loadPath(filePath: string, keyScopeFingerprint: string): Promise<LoadedCatalogCache<TCatalog> | null> {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown
      if (!isCatalogCacheEnvelope<TCatalog>(parsed)) return null
      if (parsed.keyScopeFingerprint !== keyScopeFingerprint) return null
      const catalogScope = (parsed.catalog as { keyScopeFingerprint?: unknown }).keyScopeFingerprint
      if (catalogScope !== undefined && catalogScope !== keyScopeFingerprint) return null
      const ageMs = Math.max(0, this.now() - parsed.savedAt)
      return { envelope: parsed, stale: ageMs > this.maxAgeMs, ageMs }
    } catch {
      return null
    }
  }

  async save(envelope: CatalogCacheEnvelope<TCatalog>): Promise<void> {
    const directory = dirname(this.finalPath)
    const tempPath = `${this.finalPath}.tmp`
    await mkdir(directory, { recursive: true })
    await unlink(tempPath).catch(() => undefined)

    const file = await open(tempPath, 'w', 0o600)
    try {
      await file.writeFile(JSON.stringify(envelope, null, 2), 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }

    await copyFile(this.finalPath, `${this.finalPath}.bak`).catch(() => undefined)
    await rename(tempPath, this.finalPath)
    const dir = await open(directory, 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  }
}

function isCatalogCacheEnvelope<TCatalog>(value: unknown): value is CatalogCacheEnvelope<TCatalog> {
  if (!value || typeof value !== 'object') return false
  const envelope = value as Partial<CatalogCacheEnvelope<TCatalog>>
  return typeof envelope.schemaVersion === 'number'
    && typeof envelope.parserVersion === 'string'
    && typeof envelope.keyScopeFingerprint === 'string'
    && typeof envelope.savedAt === 'number'
    && !!envelope.catalog
    && typeof envelope.catalog === 'object'
}
