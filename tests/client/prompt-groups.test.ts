import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { normalizeConfig, normalizeStyleGroups } from '../../client/normalize.js'

const PAGE_VUE = readFileSync(resolve(process.cwd(), 'client/page.vue'), 'utf8')

describe('normalizeStyleGroups (dirty input defence)', () => {
  test('non-object / array root becomes empty', () => {
    expect(normalizeStyleGroups(undefined)).toEqual({})
    expect(normalizeStyleGroups(null)).toEqual({})
    expect(normalizeStyleGroups('bad')).toEqual({})
    expect(normalizeStyleGroups(['not', 'an', 'object'])).toEqual({})
  })

  test('drops non-object group values, coerces missing/non-array prompts to []', () => {
    const result = normalizeStyleGroups({
      valid: { prompts: [{ commandName: 'a', prompt: 'p' }] },
      emptyPrompts: { prompts: null },
      noPromptsField: {},
      arrayGroup: [1, 2, 3],
      nullGroup: null,
      stringGroup: 'nope',
      '   ': { prompts: [] },
    })
    expect(Object.keys(result).sort()).toEqual(['emptyPrompts', 'noPromptsField', 'valid'])
    expect(result.valid.prompts).toEqual([{ commandName: 'a', prompt: 'p' }])
    expect(result.emptyPrompts.prompts).toEqual([])
    expect(result.noPromptsField.prompts).toEqual([])
  })

  test('each preset is deep-copied so panel edits do not leak to raw source', () => {
    const raw = { g1: { prompts: [{ commandName: 'x', prompt: 'p' }] } }
    const normalized = normalizeStyleGroups(raw)
    normalized.g1.prompts[0].commandName = 'mutated'
    normalized.g1.prompts.push({ commandName: 'added', prompt: 'q' } as any)
    expect(raw.g1.prompts[0].commandName).toBe('x')
    expect(raw.g1.prompts).toHaveLength(1)
  })

  test('normalizeConfig routes styleGroups through the same defence', () => {
    const normalized = normalizeConfig({
      styles: [{ commandName: 's1', prompt: 'p' }, null],
      styleGroups: {
        good: { prompts: [{ commandName: 'g1', prompt: 'p' }] },
        bad: 'no',
        alsoBad: null,
        noPrompts: { prompts: 'nope' },
      },
    })
    expect(Object.keys(normalized.styleGroups).sort()).toEqual(['good', 'noPrompts'])
    expect(normalized.styleGroups.noPrompts.prompts).toEqual([])
    expect(normalized.styles).toHaveLength(1)
    expect(normalized.styles[0].commandName).toBe('s1')
  })
})

describe('aka-tools panel Prompt 预设 card contract', () => {
  test('Prompt presets are placed directly after model mappings and before pricing settings', () => {
    const modelMappings = PAGE_VUE.indexOf('<!-- ══ ③ 模型映射 ══ -->')
    const promptPresets = PAGE_VUE.indexOf('<!-- ══ ④ Prompt 预设 ══ -->')
    const pricingSettings = PAGE_VUE.indexOf('<!-- ══ ⑤ 积分与运营 ══ -->')
    expect(modelMappings).toBeGreaterThan(-1)
    expect(promptPresets).toBeGreaterThan(modelMappings)
    expect(pricingSettings).toBeGreaterThan(promptPresets)
  })

  test('legacy JSON textarea and mislabelled copy are removed', () => {
    expect(PAGE_VUE).not.toContain('预设 JSON')
    expect(PAGE_VUE).not.toContain('旧版分组快捷命令')
    expect(PAGE_VUE).not.toContain('formatStyleGroupPrompts')
    expect(PAGE_VUE).not.toContain('updateStyleGroupPrompts')
  })

  test('single unified Prompt 预设 card is present', () => {
    expect(PAGE_VUE).toContain('<span>Prompt 预设</span>')
    expect(PAGE_VUE).not.toContain('Prompt 预设 / 快捷命令')
    expect(PAGE_VUE).not.toMatch(/<span>Prompt 分组<\/span>/)
  })

  test('card explains groups are admin-only classification', () => {
    expect(PAGE_VUE).toContain('分组仅用于后台分类')
    expect(PAGE_VUE).toContain('聊天中仍直接使用预设的命令名')
  })

  test('ungrouped section is bound to cfg.styles and structured (no JSON)', () => {
    expect(PAGE_VUE).toContain('未分组')
    expect(PAGE_VUE).toMatch(/v-for="\(style, i\) in cfg\.styles"/)
    expect(PAGE_VUE).toMatch(/v-for="\(style, i\) in cfg\.styleGroups\[groupName\]\.prompts"/)
  })

  test('each named group is itself a collapsible container', () => {
    expect(PAGE_VUE).toContain('class="prompt-groups-collapse"')
    expect(PAGE_VUE).toContain('v-for="groupName in styleGroupNames"')
    expect(PAGE_VUE).toContain(':title="`${groupName}（${cfg.styleGroups[groupName].prompts.length}）`"')
  })

  test('exposes helpers required by the unified card', () => {
    for (const helper of [
      'function addStylePreset',
      'function removeStylePreset',
      'function moveTargets',
      'function movePreset',
      'function addStyleGroup',
      'function removeStyleGroup',
      'function renameStyleGroup',
    ]) {
      expect(PAGE_VUE, `page.vue must define ${helper}`).toContain(helper)
    }
  })

  test('move-to dropdown wiring is present in the template', () => {
    expect(PAGE_VUE).toContain('移动到')
    expect(PAGE_VUE).toContain('moveTargets(null)')
    expect(PAGE_VUE).toContain('moveTargets(groupName)')
    expect(PAGE_VUE).toMatch(/movePreset\(null, i, \$event\)/)
    expect(PAGE_VUE).toMatch(/movePreset\(groupName, i, \$event\)/)
  })
})
