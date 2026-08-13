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
  test('model selection source is backend selectableModels (mappings UI removed)', () => {
    // 模型绑定数据源必须是后端 selectableModels（addMapping 用其首个模型作默认），
    // 前端不得硬编码模型列表；悬空的「模型映射」页已清理（不会再有 el-table 版 v-for）。
    expect(source).toContain('selectableModels.value[0]?.id ??')
    expect(source).not.toContain('v-for="m in selectableModels"')
  })
  test('console service forwards catalog unsupported models', () => {
    const serviceSource = readFileSync(resolve(process.cwd(), 'src/console/service.ts'), 'utf8')
    expect(serviceSource).toContain('unsupportedModels: snapshot.unsupportedModels')
    expect(serviceSource).not.toContain('unsupportedModels: []')
  })

})
