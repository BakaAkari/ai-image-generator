import { afterEach, describe, expect, test, vi } from 'vitest'
import { CatalogScheduler } from '../../src/catalog/catalog-scheduler.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('CatalogScheduler', () => {
  test('single-flight merges concurrent refresh requests', async () => {
    let resolveRefresh!: () => void
    let calls = 0
    const scheduler = new CatalogScheduler(async () => {
      calls += 1
      await new Promise<void>(resolve => { resolveRefresh = resolve })
    })

    const first = scheduler.refreshNow()
    const second = scheduler.refreshNow()
    expect(first).toBe(second)
    expect(calls).toBe(1)
    resolveRefresh()
    await first
  })

  test('updating interval disposes the old timer', async () => {
    vi.useFakeTimers()
    let calls = 0
    const scheduler = new CatalogScheduler(async () => { calls += 1 })
    scheduler.start(2)
    scheduler.updateInterval(1)

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(calls).toBe(2)
  })


  test('repeated start replaces the previous timer instead of adding another', async () => {
    vi.useFakeTimers()
    let calls = 0
    const scheduler = new CatalogScheduler(async () => { calls += 1 })
    scheduler.start(1)
    scheduler.start(1)

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(calls).toBe(1)
  })

  test('stop prevents future ticks', async () => {
    vi.useFakeTimers()
    let calls = 0
    const scheduler = new CatalogScheduler(async () => { calls += 1 })
    scheduler.start(1)
    scheduler.stop()

    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000)
    expect(calls).toBe(0)
  })
})
