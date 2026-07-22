import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('config and routing hardcoding guard', () => {
  test('service has no concrete default image model or model-name protocol inference', () => {
    const text = source('src/service/AiImageGeneratorService.ts')
    expect(text).not.toContain('DEFAULT_OPENAI_MODEL_ID')
    expect(text).not.toMatch(/\/gemini\/i\.test\(mapping\.modelId\)/)
  })

  test('legacy billing has no implicit token or global default price formula', () => {
    const text = source('src/shared/billing.ts')
    expect(text).not.toContain('ESTIMATED_TOKENS_PER_IMAGE')
    expect(text).not.toContain('TOKEN_BASE_PRICE_PER_MILLION')
    expect(text).not.toContain('defaultCreditCostPerImage')
  })

  test('schema has no concrete default model mappings', () => {
    const text = source('src/shared/config.ts')
    expect(text).not.toContain("{ suffix: 'gpt', modelId:")
    expect(text).not.toContain("{ suffix: 'gemini', modelId:")
  })
})
