import { describe, expect, it } from 'vitest'
import { resolveGrounderLoadPlan } from '@offgrid/models'

describe('resolveGrounderPlan', () => {
  it('runs as-is when the active model is already a grounder (no swap, regardless of download)', () => {
    expect(resolveGrounderLoadPlan({ activeIsGrounder: true, specialistInstalled: true })).toBe(
      'use-active-grounder'
    )
    expect(resolveGrounderLoadPlan({ activeIsGrounder: true, specialistInstalled: false })).toBe(
      'use-active-grounder'
    )
  })

  it('swaps in the dedicated grounder when it is downloaded', () => {
    expect(resolveGrounderLoadPlan({ activeIsGrounder: false, specialistInstalled: true })).toBe(
      'swap-in-grounder'
    )
  })

  it('reports a missing selected grounder instead of using a hidden active-model fallback', () => {
    expect(resolveGrounderLoadPlan({ activeIsGrounder: false, specialistInstalled: false })).toBe(
      'missing-grounder'
    )
  })
})
