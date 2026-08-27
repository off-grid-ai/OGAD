import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginSynthetic,
  endSynthetic,
  insideAnyWindow,
  isUserInput,
  resetSynthetic,
  syntheticSnapshot,
  DEFAULT_USER_INPUT_RULE
} from '../synthetic-tracker'

afterEach(() => {
  resetSynthetic()
  vi.useRealTimers()
})

const RULE = DEFAULT_USER_INPUT_RULE

describe('isUserInput (the takeover decision)', () => {
  it('never fires while a synthetic action is in flight', () => {
    expect(
      isUserInput(
        { kind: 'key', at: 1_000 },
        { inFlight: true, lastEndedAt: 0, cursor: null },
        RULE
      )
    ).toBe(false)
  })

  it('stays quiet inside the grace window after a synthetic action settles', () => {
    const synth = { inFlight: false, lastEndedAt: 10_000, cursor: null }
    expect(isUserInput({ kind: 'key', at: 10_000 + RULE.graceMs - 1 }, synth, RULE)).toBe(false)
    expect(isUserInput({ kind: 'key', at: 10_000 + RULE.graceMs + 1 }, synth, RULE)).toBe(true)
  })

  it('a cursor resting where the rail parked it is not a takeover; real drift is', () => {
    const synth = { inFlight: false, lastEndedAt: 1_000, cursor: { x: 500, y: 500 } }
    const later = 1_000 + RULE.graceMs + 1
    expect(
      isUserInput({ kind: 'mouse', at: later, point: { x: 505, y: 495 } }, synth, RULE)
    ).toBe(false) // within tolerance - jitter, not a human
    expect(
      isUserInput({ kind: 'mouse', at: later, point: { x: 700, y: 500 } }, synth, RULE)
    ).toBe(true)
  })

  it('with no synthetic history at all, any input is the user', () => {
    const synth = { inFlight: false, lastEndedAt: 0, cursor: null }
    expect(isUserInput({ kind: 'mouse', at: 5, point: { x: 1, y: 1 } }, synth, RULE)).toBe(true)
    expect(isUserInput({ kind: 'key', at: 5 }, synth, RULE)).toBe(true)
  })
})

describe('the tracker lifecycle', () => {
  it('brackets: in flight while begun, settles with a timestamp, notes the cursor', () => {
    vi.useFakeTimers()
    vi.setSystemTime(50_000)
    beginSynthetic({ x: 10, y: 20 })
    expect(syntheticSnapshot()).toMatchObject({ inFlight: true, cursor: { x: 10, y: 20 } })
    endSynthetic()
    expect(syntheticSnapshot()).toMatchObject({ inFlight: false, lastEndedAt: 50_000 })
  })

  it('nested actions stay in-flight until the last one settles', () => {
    beginSynthetic()
    beginSynthetic({ x: 1, y: 1 })
    endSynthetic()
    expect(syntheticSnapshot().inFlight).toBe(true)
    endSynthetic()
    expect(syntheticSnapshot().inFlight).toBe(false)
  })

  it('reset clears everything for a fresh run', () => {
    beginSynthetic({ x: 9, y: 9 })
    endSynthetic()
    resetSynthetic()
    expect(syntheticSnapshot()).toEqual({ inFlight: false, lastEndedAt: 0, cursor: null })
  })
})

describe('insideAnyWindow (own-overlay suppression)', () => {
  const windows = [{ x: 100, y: 100, width: 200, height: 50 }]
  it('a click on our own overlay never counts as a takeover', () => {
    expect(insideAnyWindow({ x: 150, y: 120 }, windows)).toBe(true)
    expect(insideAnyWindow({ x: 100, y: 100 }, windows)).toBe(true) // edge inclusive
  })
  it('outside is outside', () => {
    expect(insideAnyWindow({ x: 99, y: 120 }, windows)).toBe(false)
    expect(insideAnyWindow({ x: 150, y: 151 }, windows)).toBe(false)
    expect(insideAnyWindow({ x: 150, y: 120 }, [])).toBe(false)
  })
})
