import { describe, expect, test } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CatalogFileRepository, type CatalogCacheEnvelope } from '../../src/catalog/catalog-repository.js'

function envelope(scope: string, fetchedAt = 1000): CatalogCacheEnvelope {
  return {
    schemaVersion: 1,
    parserVersion: '1.0.0',
    keyScopeFingerprint: scope,
    savedAt: fetchedAt,
    catalog: {
      supplier: 'yunwu',
      schemaVersion: 1,
      parserVersion: '1.0.0',
      keyScopeFingerprint: scope,
      models: [],
      allModels: [],
      fetchedAt,
    },
  }
}

describe('CatalogFileRepository', () => {
  test('loads only a cache matching the requested key scope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'catalog-repo-'))
    const repo = new CatalogFileRepository(join(dir, 'catalog.json'))
    await repo.save(envelope('scope-a'))

    expect((await repo.load('scope-a'))?.envelope.keyScopeFingerprint).toBe('scope-a')
    expect(await repo.load('scope-b')).toBeNull()
  })

  test('marks an old matching cache stale without discarding it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'catalog-repo-'))
    const repo = new CatalogFileRepository(join(dir, 'catalog.json'), { now: () => 10_000, maxAgeMs: 2_000 })
    await repo.save(envelope('scope-a', 1_000))

    const loaded = await repo.load('scope-a')
    expect(loaded?.stale).toBe(true)
    expect(loaded?.ageMs).toBe(9_000)
  })

  test('a corrupt final file does not return a partial cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'catalog-repo-'))
    const finalPath = join(dir, 'catalog.json')
    const repo = new CatalogFileRepository(finalPath)
    await writeFile(finalPath, '{broken', 'utf8')

    expect(await repo.load('scope-a')).toBeNull()
  })


  test('falls back to the last complete backup when the final file is corrupt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'catalog-repo-'))
    const finalPath = join(dir, 'catalog.json')
    const repo = new CatalogFileRepository(finalPath)
    await repo.save(envelope('scope-a'))
    await repo.save(envelope('scope-a', 2_000))
    await writeFile(finalPath, '{broken', 'utf8')

    const loaded = await repo.load('scope-a')
    expect(loaded?.envelope.savedAt).toBe(1_000)
  })

  test('save atomically replaces the final file and leaves no temp file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'catalog-repo-'))
    const finalPath = join(dir, 'catalog.json')
    const repo = new CatalogFileRepository(finalPath)
    await repo.save(envelope('scope-a'))
    await repo.save(envelope('scope-b'))

    const stored = JSON.parse(await readFile(finalPath, 'utf8')) as CatalogCacheEnvelope
    expect(stored.keyScopeFingerprint).toBe('scope-b')
    await expect(readFile(`${finalPath}.tmp`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
