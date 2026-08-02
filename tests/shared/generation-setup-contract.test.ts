import { describe, expect, test } from 'vitest'

import { buildProtocolRequestContext } from '../../src/shared/generation-setup.js'

describe('buildProtocolRequestContext (contract-driven branch)', () => {
  test('newapi OpenAI GPT Image 2 generate: aspect+resolution → size in requestContext', () => {
    const { requestContext, rejectedParams } = buildProtocolRequestContext({
      protocol: 'openai',
      supplier: 'openai-compatible',
      routeId: 'openai:text-to-image',
      operation: 'text-to-image',
      contractId: 'newapi.openai.gpt-image-2.generate',
      modelMapping: { suffix: 'g', modelId: 'gpt-image-2' },
      explicit: { resolution: '2k', aspectRatio: '16:9', numImages: 1 },
    })
    expect(requestContext.contractId).toBe('newapi.openai.gpt-image-2.generate')
    expect(requestContext.operation).toBe('text-to-image')
    expect(requestContext.resolution).toBe('2k')
    expect(requestContext.aspectRatio).toBe('16:9')
    expect(rejectedParams).toEqual([])
  })

  test('newapi Gemini 2.5 rejects imageSize; only aspectRatio passes', () => {
    const { requestContext, rejectedParams } = buildProtocolRequestContext({
      protocol: 'gemini',
      contractId: 'newapi.gemini.2-5.generate',
      operation: 'text-to-image',
      modelMapping: { suffix: 'g', modelId: 'gemini-2.5-flash-image' },
      explicit: { imageSize: '1K', aspectRatio: '16:9' },
    })
    expect(requestContext.aspectRatio).toBe('16:9')
    // imageSize 未写入 requestContext（不是 ImageRequestContext 字段）；只体现在被拒列表
    expect(rejectedParams?.some(r => r.key === 'imageSize')).toBe(true)
    expect(requestContext.resolution).toBeUndefined()
  })

  test('MJ Imagine yields promptAppends but no OpenAI-style fields', () => {
    const { requestContext, promptAdditions } = buildProtocolRequestContext({
      protocol: 'mj',
      contractId: 'newapi.mj.imagine',
      operation: 'text-to-image',
      modelMapping: { suffix: 'mj', modelId: 'mj_imagine' },
      explicit: { aspectRatio: '16:9', stylize: 250 },
    })
    expect(promptAdditions).toContain('--ar 16:9')
    expect(promptAdditions).toContain('--stylize 250')
    expect(requestContext.promptAppends).toEqual(['--ar 16:9', '--stylize 250'])
  })

  test('explicit unknown contract id → fail-closed (known=false with rejectedParams)', () => {
    const { known, rejectedParams, requestContext } = buildProtocolRequestContext({
      protocol: 'openai',
      contractId: 'nonexistent-contract',
      modelMapping: { suffix: 'x', modelId: 'unknown-model' },
      explicit: { aspectRatio: '1:1' },
    })
    expect(known).toBe(false)
    expect(rejectedParams?.some((r) => r.key === 'contractId')).toBe(true)
    expect(requestContext.rejectedParams?.some((r) => r.key === 'contractId')).toBe(true)
  })

  test('no contractId provided → legacy PROTOCOL_PARAMS branch still supported', () => {
    const { known, rejectedParams } = buildProtocolRequestContext({
      protocol: 'openai',
      modelMapping: { suffix: 'x', modelId: 'unknown-model' },
      explicit: { aspectRatio: '1:1' },
    })
    expect(known).toBe(true)
    expect(rejectedParams).toBeUndefined()
  })

  test('contractFields propagate to requestContext (openai size)', () => {
    const { requestContext } = buildProtocolRequestContext({
      protocol: 'openai',
      contractId: 'newapi.openai.gpt-image-2.generate',
      operation: 'text-to-image',
      modelMapping: { suffix: 'g', modelId: 'gpt-image-2' },
      explicit: { resolution: '2k', aspectRatio: '16:9' },
    })
    expect(requestContext.contractFields).toBeDefined()
    expect(requestContext.contractFields?.size).toBe('2048x1152')
  })

  test('contractFields propagate: gemini 3 Pro imageSize + aspectRatio', () => {
    const { requestContext } = buildProtocolRequestContext({
      protocol: 'gemini',
      contractId: 'newapi.gemini.3-pro.generate',
      operation: 'text-to-image',
      modelMapping: { suffix: 'g3', modelId: 'gemini-3-pro-image' },
      explicit: { imageSize: '1K', aspectRatio: '16:9' },
    })
    expect(requestContext.contractFields?.imageSize).toBe('1K')
    expect(requestContext.contractFields?.aspectRatio).toBe('16:9')
  })

  test('contractFields propagate: MJ botType', () => {
    const { requestContext } = buildProtocolRequestContext({
      protocol: 'mj',
      contractId: 'newapi.mj.imagine',
      operation: 'text-to-image',
      modelMapping: { suffix: 'mj', modelId: 'mj_imagine' },
      explicit: { aspectRatio: '16:9' },
    })
    expect(requestContext.contractFields?.botType).toBe('MID_JOURNEY')
  })

  test('OpenAI explicit -1k -4:3 → rejected size, fail-closed at buildProtocolRequestContext', () => {
    const { rejectedParams, requestContext } = buildProtocolRequestContext({
      protocol: 'openai',
      contractId: 'newapi.openai.gpt-image-2.generate',
      operation: 'text-to-image',
      modelMapping: { suffix: 'g', modelId: 'gpt-image-2' },
      explicit: { resolution: '1k', aspectRatio: '4:3' },
    })
    expect(rejectedParams?.some((r) => r.key === 'size')).toBe(true)
    expect(requestContext.rejectedParams?.some((r) => r.key === 'size')).toBe(true)
  })
})
