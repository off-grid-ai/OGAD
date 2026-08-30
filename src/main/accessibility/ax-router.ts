/**
 * The cheapest-first decision for a computer_use (R5 T1e, pure half): is the
 * accessibility tree rich enough to DRIVE this app, or do we fall through to
 * vision? The router prefers AX (free, model-agnostic) and only pays for the
 * vision grounder when AX genuinely can't see the controls.
 *
 * "Rich enough" = the window exposes a workable number of ACTIONABLE elements
 * (things with AXPress or an editable field). A dead-AX app (Catalyst, a game,
 * a canvas) returns a near-empty or press-less tree - that is the signal to
 * fall to set-of-marks / vision. Pure and injected so the threshold is tested,
 * not guessed at in the host.
 */
import type { AxSnapshot } from './ax-elements'

/** Below this many actionable elements, the AX tree is too thin to drive - fall
 *  through to the next tier. A real app window (Slack, Finder, a native dialog)
 *  exposes dozens; a dead-AX surface exposes ~none. */
export const MIN_ACTIONABLE_ELEMENTS = 3

export function countActionable(snapshot: AxSnapshot): number {
  return snapshot.elements.filter(
    (el) => el.enabled && (el.actionable || el.role === 'AXTextField' || el.role === 'AXTextArea')
  ).length
}

/** True when the accessibility rail should drive this window; false means fall
 *  through to set-of-marks / vision. */
export function axRailViable(snapshot: AxSnapshot): boolean {
  return countActionable(snapshot) >= MIN_ACTIONABLE_ELEMENTS
}
