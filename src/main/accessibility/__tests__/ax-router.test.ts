/**
 * The cheapest-first routing decision: a rich AX window drives via the
 * accessibility rail; a dead-AX (Catalyst/canvas) window falls through to
 * vision. Actionable = pressable or an editable field, and enabled.
 */
import { describe, expect, it } from 'vitest'
import { axRailViable, countActionable, MIN_ACTIONABLE_ELEMENTS } from '../ax-router'
import type { AxElement, AxSnapshot } from '../ax-elements'

const el = (over: Partial<AxElement>): AxElement => ({
  index: 1,
  role: 'AXButton',
  name: 'x',
  value: '',
  cx: 0,
  cy: 0,
  actionable: true,
  enabled: true,
  ...over
})

const snap = (elements: AxElement[]): AxSnapshot => ({ windowTitle: 'App', elements })

describe('countActionable', () => {
  it('counts pressable elements and editable fields, but not static/disabled', () => {
    const s = snap([
      el({ actionable: true }), // pressable
      el({ role: 'AXTextField', actionable: false }), // editable field counts
      el({ role: 'AXTextArea', actionable: false }), // editable field counts
      el({ role: 'AXStaticText', actionable: false }), // static - no
      el({ actionable: true, enabled: false }) // disabled - no
    ])
    expect(countActionable(s)).toBe(3)
  })
})

describe('axRailViable', () => {
  it('drives via AX when the window has enough actionable elements', () => {
    const rich = snap(
      Array.from({ length: MIN_ACTIONABLE_ELEMENTS }, () => el({ actionable: true }))
    )
    expect(axRailViable(rich)).toBe(true)
  })

  it('falls through to vision on a dead-AX window (too few actionable)', () => {
    // A Catalyst/canvas app: a couple of static labels, nothing pressable.
    const dead = snap([
      el({ role: 'AXStaticText', actionable: false }),
      el({ role: 'AXImage', actionable: false })
    ])
    expect(axRailViable(dead)).toBe(false)
    expect(axRailViable(snap([]))).toBe(false)
  })
})
