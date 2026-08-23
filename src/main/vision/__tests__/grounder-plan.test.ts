import { describe, expect, it } from 'vitest'
import { resolveGrounderPlan } from '../grounder-plan'

describe('resolveGrounderPlan', () => {
  it('runs as-is when the active model is already a grounder (no swap, regardless of download)', () => {
    expect(resolveGrounderPlan(true, true)).toBe('use-active-grounder')
    expect(resolveGrounderPlan(true, false)).toBe('use-active-grounder')
  })

  it('swaps in the dedicated grounder when it is downloaded', () => {
    expect(resolveGrounderPlan(false, true)).toBe('swap-in-grounder')
  })

  it('falls back to the active model when the grounder is NOT downloaded - never hard-fails', () => {
    // The whole point of this change: a missing grounder must not kill the task; the
    // computer-use run proceeds on the active vision model (with a warning) instead.
    expect(resolveGrounderPlan(false, false)).toBe('fallback-active-model')
  })
})
