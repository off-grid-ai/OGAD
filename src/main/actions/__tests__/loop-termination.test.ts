import { describe, expect, it } from 'vitest'
import { DEFAULT_TERMINATION, LoopTerminator } from '../loop-termination'

const cfg = { noProgressLimit: 3, repeatLimit: 4, hardCap: 20 }

describe('LoopTerminator - no progress', () => {
  it('keeps going while the state changes every step', () => {
    const t = new LoopTerminator(cfg)
    for (let i = 0; i < 15; i++) {
      expect(t.step(`state-${i}`).stop).toBe(false)
    }
  })

  it('stops after the state is unchanged for noProgressLimit steps', () => {
    const t = new LoopTerminator(cfg)
    expect(t.step('same')).toEqual({ stop: false }) // baseline
    expect(t.step('same')).toEqual({ stop: false }) // no-progress 1
    expect(t.step('same')).toEqual({ stop: false }) // no-progress 2
    expect(t.step('same')).toEqual({ stop: true, reason: 'made no progress for 3 steps' })
  })

  it('a real change resets the no-progress counter', () => {
    const t = new LoopTerminator(cfg)
    t.step('a')
    t.step('a') // 1
    t.step('a') // 2
    expect(t.step('b').stop).toBe(false) // changed - reset
    expect(t.step('b').stop).toBe(false) // 1
    expect(t.step('b').stop).toBe(false) // 2
    expect(t.step('b')).toEqual({ stop: true, reason: 'made no progress for 3 steps' })
  })
})

describe('LoopTerminator - repeated action (the A-B-A-B loop)', () => {
  it('stops when one action signature fires repeatLimit times, even alternating', () => {
    const t = new LoopTerminator(cfg)
    // A, B, A, B, A, B, A -> A reaches 4 firings on the 7th action.
    const seq = ['A', 'B', 'A', 'B', 'A', 'B', 'A']
    const verdicts = seq.map((s) => t.action(s))
    expect(verdicts.slice(0, 6).every((v) => !v.stop)).toBe(true)
    expect(verdicts[6]).toEqual({ stop: true, reason: 'repeated the same action 4 times' })
  })

  it('ignores terminal/unparsed steps (null signature)', () => {
    const t = new LoopTerminator(cfg)
    for (let i = 0; i < 50; i++) {
      expect(t.action(null).stop).toBe(false)
    }
  })

  it('distinct actions never trip the repeat guard', () => {
    const t = new LoopTerminator(cfg)
    for (let i = 0; i < 15; i++) {
      expect(t.action(`act-${i}`).stop).toBe(false)
    }
  })
})

describe('LoopTerminator - hard backstop', () => {
  it('stops at the absolute ceiling even when every state differs', () => {
    const t = new LoopTerminator({ ...cfg, hardCap: 5 })
    for (let i = 0; i < 5; i++) {
      expect(t.step(`unique-${i}`).stop).toBe(false)
    }
    expect(t.step('unique-6')).toEqual({ stop: true, reason: 'hit the 5-step runaway backstop' })
  })

  it('ships a high default ceiling - a seatbelt, not a task-length limit', () => {
    expect(DEFAULT_TERMINATION.hardCap).toBeGreaterThanOrEqual(200)
    expect(DEFAULT_TERMINATION.noProgressLimit).toBeLessThan(DEFAULT_TERMINATION.hardCap)
  })
})
