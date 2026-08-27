/**
 * The single owner of "the rail is sending synthetic input right now". The
 * actuation adapter marks every synthetic action (in-flight + where it left the
 * cursor); the user-input watchdog consults this to tell a human touching the
 * mouse/keyboard apart from the rail's own output. Pure state - no Electron,
 * no timers - so the decision rule is unit-testable.
 */

export interface SyntheticSnapshot {
  /** A synthetic action's promise is currently in flight. */
  inFlight: boolean
  /** When the last synthetic action settled (epoch ms; 0 = never). */
  lastEndedAt: number
  /** Where synthetic input last left the cursor (screen px), if known. */
  cursor: { x: number; y: number } | null
}

let inFlightCount = 0
let lastEndedAt = 0
let cursor: { x: number; y: number } | null = null

export function beginSynthetic(target?: { x: number; y: number }): void {
  inFlightCount += 1
  if (target) {
    cursor = { ...target }
  }
}

export function endSynthetic(): void {
  inFlightCount = Math.max(0, inFlightCount - 1)
  lastEndedAt = Date.now()
}

export function syntheticSnapshot(): SyntheticSnapshot {
  return { inFlight: inFlightCount > 0, lastEndedAt, cursor: cursor && { ...cursor } }
}

/** Test/lifecycle reset - a new supervised run starts from a clean slate. */
export function resetSynthetic(): void {
  inFlightCount = 0
  lastEndedAt = 0
  cursor = null
}

export interface InputEvent {
  kind: 'mouse' | 'key'
  at: number
  /** Screen position for mouse events (poll fallback + hook events). */
  point?: { x: number; y: number }
}

export interface UserInputRule {
  /** Quiet period after a synthetic action settles - system echo, focus shifts
   *  and the OS delivering our own events land inside it. */
  graceMs: number
  /** Cursor drift below this many px from where synthetic input parked it is
   *  not a takeover (sub-pixel jitter, high-DPI rounding). */
  tolerancePx: number
}

export const DEFAULT_USER_INPUT_RULE: UserInputRule = { graceMs: 600, tolerancePx: 24 }

/**
 * Is this event a HUMAN touching the machine? False while a synthetic action is
 * in flight or just settled, and for mouse positions still resting where the
 * rail parked the cursor. Everything else is the user - the guard pauses.
 */
export function isUserInput(
  event: InputEvent,
  synth: SyntheticSnapshot,
  rule: UserInputRule = DEFAULT_USER_INPUT_RULE
): boolean {
  if (synth.inFlight) {
    return false
  }
  if (synth.lastEndedAt > 0 && event.at - synth.lastEndedAt < rule.graceMs) {
    return false
  }
  if (event.kind === 'mouse' && event.point && synth.cursor) {
    const dx = event.point.x - synth.cursor.x
    const dy = event.point.y - synth.cursor.y
    if (Math.hypot(dx, dy) <= rule.tolerancePx) {
      return false
    }
  }
  return true
}

/** Is a screen point inside any of the given window rectangles? Interactions
 *  with our OWN windows (the supervisor overlay's Pause/Resume/Stop) must never
 *  count as a takeover, or resuming would instantly re-pause. */
export function insideAnyWindow(
  point: { x: number; y: number },
  windows: readonly { x: number; y: number; width: number; height: number }[]
): boolean {
  return windows.some(
    (w) =>
      point.x >= w.x && point.x <= w.x + w.width && point.y >= w.y && point.y <= w.y + w.height
  )
}
