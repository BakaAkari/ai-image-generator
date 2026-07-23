import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SOURCE = readFileSync(resolve(process.cwd(), 'src/shared/config.ts'), 'utf8')

describe('Config Schema hidden guard', () => {
  test('builds Config from one centrally maintained group list', () => {
    expect(SOURCE).toContain('const CONFIG_GROUPS = [')
    expect(SOURCE).toMatch(/Schema\.intersect\([\s\S]*CONFIG_GROUPS/)
  })

  test('uniformly hides and collapses every top-level group', () => {
    expect(SOURCE).toMatch(/CONFIG_GROUPS[\s\S]*\.map\(\(group\) => group\.hidden\(\)\.collapse\(\)\)/)
  })

  test('does not export a second visible Config schema', () => {
    expect((SOURCE.match(/export const Config\s*=/g) ?? []).length).toBe(1)
  })
})