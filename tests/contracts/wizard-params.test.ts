/**
 * filterParamsForContract 单测（向导契约感知参数过滤）。
 *
 * 基于 registry 中真实契约验证：不可用枚举选项移除、不支持的参数移除、
 * 数字范围收窄、默认值合法性修复、无契约保守透传。
 */
import { describe, expect, test } from 'vitest'

import { filterParamsForContract } from '../../src/contracts/wizard-params.js'
import { getContractById } from '../../src/contracts/registry.js'
import { PROTOCOL_PARAMS } from '../../src/shared/protocol-params.js'

const openaiParams = PROTOCOL_PARAMS.openai.params
const geminiParams = PROTOCOL_PARAMS.gemini.params
const mjParams = PROTOCOL_PARAMS.mj.params

function paramOf(params: any[], key: string) {
  return params.find(p => p.key === key)
}

describe('filterParamsForContract · openai', () => {
  test('gpt-image-2：移除契约表外的 4:3，保留其余比例与全部分辨率等级', () => {
    const contract = getContractById('newapi.openai.gpt-image-2.generate')!
    const filtered = filterParamsForContract(contract, openaiParams)

    expect(paramOf(filtered, 'resolution').options).toEqual(['1k', '2k', '4k'])
    expect(paramOf(filtered, 'aspectRatio').options).toEqual(['1:1', '16:9', '9:16', '3:2', '2:3'])
    // n 保留且上限收窄到契约 maxN
    expect(paramOf(filtered, 'n').max).toBe(4)
  })

  test('gpt-image-1：只有 1K + 1:1，分辨率与比例选项收窄到唯一合法值', () => {
    const contract = getContractById('newapi.openai.gpt-image-1.generate')!
    const filtered = filterParamsForContract(contract, openaiParams)

    expect(paramOf(filtered, 'resolution').options).toEqual(['1k'])
    expect(paramOf(filtered, 'aspectRatio').options).toEqual(['1:1'])
    // 默认值仍合法（1k / 1:1 都在表内）
    expect(paramOf(filtered, 'resolution').default).toBe('1k')
    expect(paramOf(filtered, 'aspectRatio').default).toBe('1:1')
  })

  test('gpt-image-2-c：supportsN=false → 移除「生成张数」参数', () => {
    const contract = getContractById('newapi.openai.gpt-image-2-c.generate')!
    const filtered = filterParamsForContract(contract, openaiParams)

    expect(paramOf(filtered, 'n')).toBeUndefined()
    expect(paramOf(filtered, 'resolution')).toBeDefined()
    expect(paramOf(filtered, 'aspectRatio')).toBeDefined()
  })

  test('默认值不在过滤结果中时替换为首个可选项', () => {
    const contract = getContractById('newapi.openai.gpt-image-2.generate')!
    // 构造默认值为 4:3（契约不支持）的参数定义
    const custom = openaiParams.map(p =>
      p.key === 'aspectRatio' ? { ...p, default: '4:3' } : p,
    )
    const filtered = filterParamsForContract(contract, custom)
    expect(paramOf(filtered, 'aspectRatio').default).toBe('1:1')
  })
})

describe('filterParamsForContract · gemini', () => {
  test('云雾 2.5 generate：imageSizes 为空（不发送 imageSize）→ 移除分辨率参数，比例全保留', () => {
    const contract = getContractById('newapi.gemini.2-5.generate')!
    const filtered = filterParamsForContract(contract, geminiParams)

    expect(paramOf(filtered, 'imageSize')).toBeUndefined()
    expect(paramOf(filtered, 'aspectRatio').options).toEqual(geminiParams[1].options)
  })

  test('云雾 3 Pro generate：imageSizes 1K/2K/4K 全保留', () => {
    const contract = getContractById('newapi.gemini.3-pro.generate')!
    const filtered = filterParamsForContract(contract, geminiParams)

    expect(paramOf(filtered, 'imageSize').options).toEqual(['1K', '2K', '4K'])
    expect(paramOf(filtered, 'aspectRatio')).toBeDefined()
  })

  test('编辑契约 imageConfig.enabled=false → 分辨率与宽高比都移除', () => {
    const contract = getContractById('newapi.gemini.3-pro.edit')!
    const filtered = filterParamsForContract(contract, geminiParams)

    expect(filtered).toHaveLength(0)
  })
})

describe('filterParamsForContract · mj', () => {
  test('imagine 契约：全比例 + stylize 保留', () => {
    const contract = getContractById('newapi.mj.imagine')!
    const filtered = filterParamsForContract(contract, mjParams)

    expect(paramOf(filtered, 'ar').options).toEqual(mjParams[0].options)
    expect(paramOf(filtered, 'stylize')).toBeDefined()
  })

  test('supportsStylize=false → 移除风格化参数；aspectRatios 收窄', () => {
    const base = getContractById('newapi.mj.imagine')!
    const contract = {
      ...base,
      mj: { ...base.mj!, supportsStylize: false, aspectRatios: ['1:1', '16:9'] as any },
    }
    const filtered = filterParamsForContract(contract, mjParams)

    expect(paramOf(filtered, 'stylize')).toBeUndefined()
    expect(paramOf(filtered, 'ar').options).toEqual(['1:1', '16:9'])
  })
})

describe('filterParamsForContract · 保守分支', () => {
  test('无契约 → 原样返回', () => {
    expect(filterParamsForContract(undefined, openaiParams)).toBe(openaiParams)
  })
})
