/**
 * direct-intent 判定：仅根据 parseStyleCommandModifiers 已识别到的语法与 -n 选项。
 *
 * 关键属性：
 * - 完全配置驱动：任一 `modelMappings.suffix` 命中即视作直接意图，没有硬编码模型名。
 * - 分辨率 / 比例 / -add / 有效 -n 也算作直接意图。
 * - 未识别后缀不会误判为已识别模型意图（因为它不会写入 modifiers.modelMapping）。
 */
import { describe, expect, test, vi } from 'vitest'

// koishi 完整加载会引入 @koishijs/loader 的 TS 源码，导致 vitest 出错；
// 这里只用到 `h.parse` / `h.select` 的最小语义，直接 stub 掉。
vi.mock('koishi', () => {
  const parseText = (raw: string) => {
    const s = typeof raw === 'string' ? raw : ''
    return s ? [{ type: 'text', attrs: { content: s }, children: [] }] : []
  }
  const select = (elements: any[], selector: string) => {
    if (!Array.isArray(elements)) return []
    return elements.filter((el) => el?.type === selector)
  }
  return { Argv: class {}, h: { parse: parseText, select }, Schema: class {} }
})

import { detectDirectIntent } from '../../src/shared/direct-intent.js'
import { buildModelMappingIndex, parseStyleCommandModifiers } from '../../src/utils/parser.js'
import type { ModelMappingConfig } from '../../src/shared/types.js'
type Argv = any

// 用一个刻意"陌生"的 suffix 证明检测不依赖硬编码模型列表
const mappings: ModelMappingConfig[] = [
  { suffix: 'zebra42', modelId: 'zebra-model-42' },
  { suffix: 'gpt', modelId: 'gpt-image-1' },
]
const modelIndex = buildModelMappingIndex(mappings)

function argvFor(content: string, options: Record<string, unknown> = {}): Argv {
  return {
    session: { content } as any,
    args: [],
    options,
    rest: '',
  } as unknown as Argv
}

describe('detectDirectIntent — 纯值判定', () => {
  test('空 modifiers + 无 -n → false', () => {
    expect(detectDirectIntent({}, undefined)).toBe(false)
    expect(detectDirectIntent(undefined, undefined)).toBe(false)
  })

  test('modelMapping 命中 → true', () => {
    expect(detectDirectIntent({ modelMapping: mappings[0] }, undefined)).toBe(true)
  })

  test('resolution 命中（预设 1k / 自定义 1024x2048）→ true', () => {
    expect(detectDirectIntent({ resolution: '1k' }, undefined)).toBe(true)
    expect(detectDirectIntent({ resolution: '1024x2048' as any }, undefined)).toBe(true)
  })

  test('aspectRatio 命中 → true', () => {
    expect(detectDirectIntent({ aspectRatio: '16:9' }, undefined)).toBe(true)
  })

  test('customAdditions 非空 → true；空数组 → false', () => {
    expect(detectDirectIntent({ customAdditions: ['extra'] }, undefined)).toBe(true)
    expect(detectDirectIntent({ customAdditions: [] }, undefined)).toBe(false)
  })

  test('有效 -n 数字 → true；NaN/undefined → false', () => {
    expect(detectDirectIntent({}, 4)).toBe(true)
    expect(detectDirectIntent({}, Number.NaN)).toBe(false)
    expect(detectDirectIntent({}, undefined)).toBe(false)
  })
})

describe('detectDirectIntent — 配置驱动，无模型硬编码', () => {
  test('已配置的任意 suffix（含刻意陌生名 zebra42）都能触发 direct', () => {
    const mods = parseStyleCommandModifiers(argvFor('文生图 猫 -zebra42'), undefined, modelIndex)
    expect(mods.modelMapping?.modelId).toBe('zebra-model-42')
    expect(detectDirectIntent(mods, undefined)).toBe(true)
  })

  test('未识别的后缀不会误判为模型意图（也不会误触发 direct）', () => {
    const mods = parseStyleCommandModifiers(argvFor('文生图 猫 -no-such-suffix'), undefined, modelIndex)
    expect(mods.modelMapping).toBeUndefined()
    // 单独一个未知后缀不写入 resolution / aspectRatio / customAdditions
    expect(detectDirectIntent(mods, undefined)).toBe(false)
  })

  test('模型后缀 + 比例 → direct', () => {
    const mods = parseStyleCommandModifiers(argvFor('文生图 猫 -zebra42 -16:9'), undefined, modelIndex)
    expect(mods.modelMapping?.modelId).toBe('zebra-model-42')
    expect(mods.aspectRatio).toBe('16:9')
    expect(detectDirectIntent(mods, undefined)).toBe(true)
  })

  test('仅 -1k → direct', () => {
    const mods = parseStyleCommandModifiers(argvFor('文生图 猫 -1k'), undefined, modelIndex)
    expect(mods.resolution).toBe('1k')
    expect(mods.modelMapping).toBeUndefined()
    expect(detectDirectIntent(mods, undefined)).toBe(true)
  })

  test('仅 -16:9 → direct', () => {
    const mods = parseStyleCommandModifiers(argvFor('文生图 猫 -16:9'), undefined, modelIndex)
    expect(mods.aspectRatio).toBe('16:9')
    expect(detectDirectIntent(mods, undefined)).toBe(true)
  })

  test('自定义分辨率 -1024x2048 → direct', () => {
    const mods = parseStyleCommandModifiers(argvFor('文生图 猫 -1024x2048'), undefined, modelIndex)
    expect(mods.resolution).toBe('1024x2048')
    expect(detectDirectIntent(mods, undefined)).toBe(true)
  })

  test('-add 追加片段 → direct', () => {
    const mods = parseStyleCommandModifiers(argvFor('文生图 猫 -add 强化细节'), undefined, modelIndex)
    expect(mods.customAdditions?.length).toBeGreaterThan(0)
    expect(detectDirectIntent(mods, undefined)).toBe(true)
  })

  test('普通 prompt 无任何语法 → not direct', () => {
    const mods = parseStyleCommandModifiers(argvFor('文生图 一只可爱的猫'), undefined, modelIndex)
    expect(detectDirectIntent(mods, undefined)).toBe(false)
  })
})
