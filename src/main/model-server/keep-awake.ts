// Team gateway mode keeps the machine awake while it serves clients, so a shared server does not
// fall asleep in the middle of someone's request. The blocker itself (Electron's powerSaveBlocker)
// is the host's: the gateway runs embedded or headless and never imports Electron.
//
// Held while any team-mode request is in flight; let go a grace period after the last one ends,
// at once when the gateway is in single mode, and when the gateway stops.

/** The host's sleep blocker (Electron's powerSaveBlocker has exactly this shape). */
export interface PowerBlocker {
  start(type: 'prevent-app-suspension'): number
  stop(id: number): void
}

export class TeamKeepAwake {
  private id: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly blocker: PowerBlocker,
    private readonly graceMs: number
  ) {}

  /** Whether the machine is being kept awake now. */
  get held(): boolean {
    return this.id !== null
  }

  /** Called whenever team-mode work starts or ends: `team` is the gateway mode now, `busy`
   *  whether any team-mode request is in flight. */
  update(team: boolean, busy: boolean): void {
    if (!team) return this.release()
    if (busy) {
      this.clearTimer()
      if (this.id === null) this.id = this.blocker.start('prevent-app-suspension')
      return
    }
    if (this.id === null || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.release()
    }, this.graceMs)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  /** Let the machine sleep again. */
  release(): void {
    this.clearTimer()
    if (this.id === null) return
    this.blocker.stop(this.id)
    this.id = null
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }
}
