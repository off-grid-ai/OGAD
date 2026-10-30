import { roundMs } from './properties'

/** One session: when it started, and its time with one of the app's windows focused. */
export interface SessionState {
  startedAt: number
  /** Time with one of the app's windows focused, before `foregroundSince`. */
  foregroundMs: number
  /** When the current focused stretch began; null while in the background. */
  foregroundSince: number | null
  lastAt: number
}

export class SessionTally {
  private constructor(readonly state: SessionState) {}

  static start(now: number): SessionTally {
    return new SessionTally({ startedAt: now, foregroundMs: 0, foregroundSince: now, lastAt: now })
  }

  foreground(now: number): void {
    if (this.state.foregroundSince === null) this.state.foregroundSince = now
    this.state.lastAt = now
  }

  background(now: number): void {
    const since = this.state.foregroundSince
    if (since !== null) this.state.foregroundMs += Math.max(0, now - since)
    this.state.foregroundSince = null
    this.state.lastAt = now
  }

  /** Foreground time so far. */
  sessionMs(now: number): number {
    const since = this.state.foregroundSince
    return roundMs(this.state.foregroundMs + (since !== null ? Math.max(0, now - since) : 0))
  }
}
