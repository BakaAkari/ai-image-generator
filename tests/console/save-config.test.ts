import { describe, expect, it, vi } from 'vitest'

import { registerConsoleService } from '../../src/console/service.js'

function config(value: number) {
  return { dailyFreeCredits: value, modelMappings: [], styles: [] } as any
}

describe('aka-tools save listener', () => {
  it('persists JSON then updates the live plugin config without scope.update', async () => {
    const listeners = new Map<string, Function>()
    const scopeUpdate = vi.fn()
    const writeConfig = vi.fn(async () => {})
    const merged = config(10)
    const mergeConfig = vi.fn(() => merged)
    const applyConfig = vi.fn(async () => {})
    const ctx = {
      scope: { update: scopeUpdate },
      console: { addListener: (name: string, listener: Function) => listeners.set(name, listener) },
    } as any

    registerConsoleService({
      ctx,
      logger: { warn: vi.fn() } as any,
      catalog: { current: null, billingInfo: null } as any,
      getConfig: () => config(1),
      refreshCatalog: async () => {},
      writeConfig,
      applyConfig,
      mergeConfig,
    })

    const next = config(9)
    const result = await listeners.get('image-generator/save-config')!(next)

    expect(result).toEqual({ success: true })
    expect(mergeConfig).toHaveBeenCalledWith(config(1), next)
    expect(writeConfig).toHaveBeenCalledWith(merged)
    expect(applyConfig).toHaveBeenCalledWith(merged)
    expect(writeConfig.mock.invocationCallOrder[0]).toBeLessThan(applyConfig.mock.invocationCallOrder[0])
    expect(scopeUpdate).not.toHaveBeenCalled()
  })
})
