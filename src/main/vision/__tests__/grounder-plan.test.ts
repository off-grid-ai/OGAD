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

  it('reports a missing selected grounder instead of using a hidden active-model fallback', () => {
    expect(resolveGrounderPlan(false, false)).toBe('missing-grounder')
  })
})
