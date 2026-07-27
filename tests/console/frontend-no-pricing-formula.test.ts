import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('aka-tools frontend pricing guard', () => {
  const source = readFileSync(resolve(process.cwd(), 'client/page.vue'), 'utf8')
  test('frontend contains no pricing arithmetic', () => {
    expect(source).not.toContain('autoCredits')
    expect(source).not.toContain('0.004')
    expect(source).not.toMatch(/pricePerCall\s*\*/)
  })
  test('freeTrialModelId selector is present in operations panel', () => {
    expect(source).toContain('freeTrialModelId')
    expect(source).toContain('每日免费试用模型')
    expect(source).toContain('选择模型映射中的 modelId')
  })
  test('only backend selectableModels feed the model selector', () => {
    expect(source).toContain('v-for="m in selectableModels"')
  })
  test('console service forwards catalog unsupported models', () => {
    const serviceSource = readFileSync(resolve(process.cwd(), 'src/console/service.ts'), 'utf8')
    expect(serviceSource).toContain('unsupportedModels: snapshot.unsupportedModels')
    expect(serviceSource).not.toContain('unsupportedModels: []')
  })

})
