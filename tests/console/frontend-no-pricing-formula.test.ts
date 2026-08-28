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
  test('model selection source is backend selectableModels (editable mapping editor)', () => {
    // 模型绑定数据源必须是后端 selectableModels：模型映射编辑器（模型定价页）里
    // modelId 用下拉从 selectableModels 选择（addMapping 用其首个模型作默认），
    // 前端不硬编码具体模型列表；新增模型映射的能力在两种定价模式下都在。
    expect(source).toContain('selectableModels.value[0]?.id ??')
    // 映射表内 modelId 下拉的数据源来自 selectableModels，而非硬编码列表
    expect(source).toContain('v-for="m in selectableModels"')
    expect(source).toContain('v-model="row.modelId"')
  })
  test('console service forwards catalog unsupported models', () => {
    const serviceSource = readFileSync(resolve(process.cwd(), 'src/console/service.ts'), 'utf8')
    expect(serviceSource).toContain('unsupportedModels: snapshot.unsupportedModels')
    expect(serviceSource).not.toContain('unsupportedModels: []')
  })

})
