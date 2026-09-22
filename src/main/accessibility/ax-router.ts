/**
 * The cheapest-first decision for a computer_use (R5 T1e, pure half): is the
 * accessibility tree rich enough to DRIVE this app, or do we fall through to
 * vision? The router prefers AX (free, model-agnostic) and only pays for the
 * vision grounder when AX genuinely can't see the controls.
 *
 * A dead-AX app (Catalyst, a game, or a canvas) exposes no executable control.
 * Any executable control is enough for the Decision model to inspect the
 * structured route before visual recovery is considered.
 */
import type { AxSnapshot } from './ax-elements'

export const MIN_ACTIONABLE_ELEMENTS = 1

export function countActionable(snapshot: AxSnapshot): number {
  return snapshot.elements.filter(
    (element) =>
      element.enabled &&
      element.executable !== false &&
      (element.actionable ||
        element.role === 'AXTextField' ||
        element.role === 'AXTextArea' ||
        element.role === 'AXSearchField' ||
        element.role === 'AXComboBox')
  ).length
}

/** True when the accessibility rail should drive this window; false means fall
 *  through to set-of-marks / vision. */
export function axRailViable(snapshot: AxSnapshot): boolean {
  return countActionable(snapshot) >= MIN_ACTIONABLE_ELEMENTS
}
