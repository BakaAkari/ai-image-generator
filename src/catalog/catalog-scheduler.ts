export type CatalogRefresh = () => Promise<void>

export class CatalogScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private intervalHours: number | null = null
  private inFlight: Promise<void> | null = null

  constructor(private readonly refresh: CatalogRefresh) {}

  start(hours: number): void {
    this.install(hours)
  }

  updateInterval(hours: number): void {
    this.install(hours)
  }

  refreshNow(): Promise<void> {
    if (this.inFlight) return this.inFlight
    const run = this.refresh()
    let wrapped: Promise<void>
    wrapped = run.finally(() => {
      if (this.inFlight === wrapped) this.inFlight = null
    })
    this.inFlight = wrapped
    return wrapped
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.intervalHours = null
  }

  private install(hours: number): void {
    if (!Number.isFinite(hours) || hours <= 0) throw new Error('catalog refresh interval must be positive')
    this.stop()
    this.intervalHours = hours
    this.timer = setInterval(() => { void this.refreshNow() }, hours * 60 * 60 * 1000)
  }
}
