import { SCROLL_BUCKETS, type ScrollBucket } from '../../shared/analytics'
import { roundMs } from './properties'

/**
 * Per-interaction counters, kept on the device and sent once per session as `session_summary`.
 * A click, a shortcut or a scroll is never an event of its own: that keeps the event budget
 * (docs/ANALYTICS.md) and sends nothing a single interaction could reveal.
 */
export const SUMMARY_COUNTERS = [
  'actions',
  'shortcuts',
  'commands',
  'errors_shown',
  'error_responses',
  'empty_states',
  'notifications_clicked',
  'chat_inputs',
  'settings_changed'
] as const
export type SummaryCounter = (typeof SUMMARY_COUNTERS)[number]

/** Keys a summary sends per counter: the most used first. */
export const SUMMARY_KEY_CAP = 50
/** Keys held per counter while the session runs, so a runaway source cannot grow it. */
const TRACKED_KEY_CAP = 200
const KEY = /^[a-z0-9][a-z0-9:_=-]{0,95}$/i

export interface SessionState {
  startedAt: number
  /** Time with one of the app's windows focused, before `foregroundSince`. */
  foregroundMs: number
  /** When the current focused stretch began; null while in the background. */
  foregroundSince: number | null
  lastAt: number
  screens: string[]
  screenViews: number
  maxScroll: Record<string, ScrollBucket>
  counters: Record<SummaryCounter, Record<string, number>>
}

function emptyCounters(): Record<SummaryCounter, Record<string, number>> {
  return Object.fromEntries(SUMMARY_COUNTERS.map((name) => [name, {}])) as Record<
    SummaryCounter,
    Record<string, number>
  >
}

function topKeys(counts: Record<string, number>, cap: number): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, cap)
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

export class SessionTally {
  private constructor(readonly state: SessionState) {}

  static start(now: number): SessionTally {
    return new SessionTally({
      startedAt: now,
      foregroundMs: 0,
      foregroundSince: now,
      lastAt: now,
      screens: [],
      screenViews: 0,
      maxScroll: {},
      counters: emptyCounters()
    })
  }

  /** A session persisted before the app died. Anything malformed is dropped, not repaired. */
  static restore(raw: unknown): SessionTally | null {
    if (!isRecord(raw)) return null
    const num = (value: unknown): number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
    const counters = emptyCounters()
    if (isRecord(raw.counters)) {
      for (const name of SUMMARY_COUNTERS) {
        const counts = raw.counters[name]
        if (!isRecord(counts)) continue
        for (const [key, count] of Object.entries(counts).slice(0, TRACKED_KEY_CAP)) {
          if (KEY.test(key) && isCount(count)) counters[name][key] = count
        }
      }
    }
    const maxScroll: Record<string, ScrollBucket> = {}
    if (isRecord(raw.maxScroll)) {
      for (const [screen, pct] of Object.entries(raw.maxScroll).slice(0, TRACKED_KEY_CAP)) {
        if (KEY.test(screen) && (SCROLL_BUCKETS as readonly unknown[]).includes(pct))
          maxScroll[screen] = pct as ScrollBucket
      }
    }
    const screens = Array.isArray(raw.screens)
      ? raw.screens.filter((s): s is string => typeof s === 'string' && KEY.test(s))
      : []
    const startedAt = num(raw.startedAt)
    if (!startedAt) return null
    const lastAt = Math.max(startedAt, num(raw.lastAt))
    const since = typeof raw.foregroundSince === 'number' ? num(raw.foregroundSince) : null
    return new SessionTally({
      startedAt,
      // A crash ends the foreground stretch at the last thing that happened.
      foregroundMs: num(raw.foregroundMs) + (since !== null ? Math.max(0, lastAt - since) : 0),
      foregroundSince: null,
      lastAt,
      screens: screens.slice(0, TRACKED_KEY_CAP),
      screenViews: Math.floor(num(raw.screenViews)),
      maxScroll,
      counters
    })
  }

  count(counter: SummaryCounter, key: string, now: number): void {
    if (!KEY.test(key)) return
    const counts = this.state.counters[counter]
    if (counts[key] === undefined && Object.keys(counts).length >= TRACKED_KEY_CAP) return
    counts[key] = (counts[key] ?? 0) + 1
    this.state.lastAt = now
  }

  screenViewed(screen: string, now: number): void {
    this.state.screenViews += 1
    if (!this.state.screens.includes(screen) && this.state.screens.length < TRACKED_KEY_CAP)
      this.state.screens.push(screen)
    this.state.lastAt = now
  }

  scrolled(screen: string, pct: ScrollBucket, now: number): void {
    if (!KEY.test(screen)) return
    const known = this.state.maxScroll[screen]
    if (known === undefined && Object.keys(this.state.maxScroll).length >= TRACKED_KEY_CAP) return
    if (known === undefined || pct > known) this.state.maxScroll[screen] = pct
    this.state.lastAt = now
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

  /** The `session_summary` properties, each map capped to its most used keys. */
  summary(now: number): Record<string, unknown> {
    const { state } = this
    const properties: Record<string, unknown> = {
      session_ms: this.sessionMs(now),
      screens: state.screens.length,
      screen_views: state.screenViews,
      max_scroll_pct: Object.fromEntries(Object.entries(state.maxScroll).slice(0, SUMMARY_KEY_CAP))
    }
    for (const name of SUMMARY_COUNTERS) {
      properties[name] = topKeys(state.counters[name], SUMMARY_KEY_CAP)
    }
    return properties
  }

  toJSON(): SessionState {
    return this.state
  }
}
