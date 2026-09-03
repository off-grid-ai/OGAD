/**
 * The cheapest-first decision for a computer_use: is the accessibility tree rich enough to DRIVE
 * this app, or do we fall through to vision? The threshold and the count rule are
 * `@offgrid/automation`'s (`accessibility-policy`); this module hands it the snapshot's elements.
 */
import { accessibilityRailViable, countActionableElements } from '@offgrid/automation'
import type { AxSnapshot } from './ax-elements'

export { MIN_ACTIONABLE_ELEMENTS } from '@offgrid/automation'

export function countActionable(snapshot: AxSnapshot): number {
  return countActionableElements(snapshot.elements)
}

/** True when the accessibility rail should drive this window; false means fall
 *  through to set-of-marks / vision. */
export function axRailViable(snapshot: AxSnapshot): boolean {
  return accessibilityRailViable(snapshot.elements)
}
