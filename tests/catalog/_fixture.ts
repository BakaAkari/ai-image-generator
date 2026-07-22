import { readFileSync } from 'fs'
import { resolve } from 'path'

export function loadJson(name: string): unknown {
  const path = resolve(process.cwd(), `tests/fixtures/yunwu/${name}`)
  return JSON.parse(readFileSync(path, 'utf-8'))
}
