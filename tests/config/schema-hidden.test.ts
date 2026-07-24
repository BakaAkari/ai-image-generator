import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SOURCE = readFileSync(resolve(process.cwd(), 'src/shared/config.ts'), 'utf8')

describe('Config Schema hidden guard', () => {
  test('builds Config from one centrally maintained group list', () => {
    expect(SOURCE).toContain('const CONFIG_GROUPS = [')
    expect(SOURCE).toMatch(/Schema\.intersect\([\s\S]*CONFIG_GROUPS/)
  })

  test('uniformly hides and collapses every business group', () => {
    expect(SOURCE).toMatch(/CONFIG_GROUPS[\s\S]*\.map\(\(group\) => group\.hidden\(\)\.collapse\(\)\)/)
  })

  test('keeps one visible global runtime group', () => {
    expect(SOURCE).toContain("}).description('⚙️ 全局运行设置')")
    expect(SOURCE).toMatch(/Schema\.intersect\(\[\s*GlobalRuntimeSchema,/)
  })

  test('does not export a second visible Config schema', () => {
    expect((SOURCE.match(/export const Config\s*=/g) ?? []).length).toBe(1)
  })

  test('GlobalRuntimeSchema declares exactly apiTimeout, catalogRefreshHours, logLevel', () => {
    const block = SOURCE.match(/const GlobalRuntimeSchema = Schema\.object\(\{([\s\S]*?)\}\)\.description/)?.[1]
    expect(block, 'GlobalRuntimeSchema block must be present').toBeTruthy()
    expect(block).toMatch(/\bapiTimeout:\s*Schema\.number/)
    expect(block).toMatch(/\bcatalogRefreshHours:\s*Schema\.number/)
    expect(block).toMatch(/\blogLevel:\s*Schema\.union/)
  })

  test('hidden business CONFIG_GROUPS do NOT redeclare any global runtime field', () => {
    const groups = SOURCE.match(/const CONFIG_GROUPS = \[([\s\S]*?)^\] as const/m)?.[1] ?? ''
    for (const field of ['apiTimeout', 'catalogRefreshHours', 'logLevel']) {
      const bound = new RegExp(`^\\s*${field}:\\s*Schema\\.`, 'm').test(groups)
      expect(bound, `CONFIG_GROUPS must not rebind ${field} (owned by GlobalRuntimeSchema)`).toBe(false)
    }
  })
})
