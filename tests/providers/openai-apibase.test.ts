import { describe, expect, test } from 'vitest'
import { normalizeV1Base } from '../../src/providers/openai.js'

describe('normalizeV1Base', () => {
  test('appends /v1 to a bare host', () => {
    expect(normalizeV1Base('https://api.example.com')).toBe('https://api.example.com/v1')
  })

  test('trims trailing slash and appends /v1', () => {
    expect(normalizeV1Base('https://api.example.com/')).toBe('https://api.example.com/v1')
  })

  test('is idempotent when /v1 is already present', () => {
    expect(normalizeV1Base('https://api.example.com/v1')).toBe('https://api.example.com/v1')
  })

  test('is idempotent when /v1/ has a trailing slash', () => {
    expect(normalizeV1Base('https://api.example.com/v1/')).toBe('https://api.example.com/v1')
  })

  test('leaves the official OpenAI default unchanged', () => {
    expect(normalizeV1Base('https://api.openai.com/v1')).toBe('https://api.openai.com/v1')
  })

  test('composed generations URL has no doubled /v1', () => {
    const apiBase = normalizeV1Base('https://api.example.com')
    expect(`${apiBase}/images/generations`).toBe('https://api.example.com/v1/images/generations')
  })
})
