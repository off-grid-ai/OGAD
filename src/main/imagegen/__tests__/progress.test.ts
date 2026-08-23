import { describe, it, expect } from 'vitest'
import { initialProgressState, reduceProgress } from '../progress'

describe('progress reducer', () => {
  it('starts in the sampling phase with the caller seed', () => {
    const s = initialProgressState(-1)
    expect(s).toEqual({ resolvedSeed: -1, samplingDone: false, prevStep: 0, phase: 'sampling' })
  })

  it('parses a sampling step line into a progress event', () => {
    const { state, event } = reduceProgress(initialProgressState(-1), '  12/28 - 1.26s/it\n')
    expect(event).toEqual({ step: 12, total: 28, secPerStep: 1.26, phase: 'sampling' })
    expect(state.prevStep).toBe(12)
    expect(state.samplingDone).toBe(false)
  })

  it('captures the resolved seed from a "seed N" line', () => {
    const { state } = reduceProgress(initialProgressState(-1), 'using seed 123456\n')
    expect(state.resolvedSeed).toBe(123456)
  })

  it('emits only the LAST step when a chunk has several lines', () => {
    const chunk = '1/28 - 1.0s/it\n2/28 - 1.1s/it\n3/28 - 1.2s/it\n'
    const { event, state } = reduceProgress(initialProgressState(-1), chunk)
    expect(event?.step).toBe(3)
    expect(event?.secPerStep).toBe(1.2)
    expect(state.prevStep).toBe(3)
  })

  it('returns no event (only updated state) for a non-step line', () => {
    // loading lines use MB/s, not s/it, so they must NOT match.
    const { event, state } = reduceProgress(initialProgressState(9), 'loading weights 512.0MB/s\n')
    expect(event).toBeUndefined()
    expect(state.resolvedSeed).toBe(9) // seed unchanged, no "seed N"
  })

  it('parses the terminal progress-bar form when it matches the requested steps', () => {
    const { event } = reduceProgress(
      initialProgressState(-1),
      '\r[========>             ] 12/42',
      42
    )
    expect(event).toEqual({ step: 12, total: 42, secPerStep: 0, phase: 'sampling' })
  })

  it('ignores unrelated counters that do not match the requested steps', () => {
    const { event } = reduceProgress(initialProgressState(-1), 'loading tensors 12/80', 42)
    expect(event).toBeUndefined()
  })

  it('marks samplingDone once a pass reaches its total, then flips to decoding on a step drop', () => {
    let st = initialProgressState(-1)
    // full sampling pass up to the total
    ;({ state: st } = reduceProgress(st, '27/28 - 1.0s/it\n'))
    expect(st.samplingDone).toBe(false)
    ;({ state: st } = reduceProgress(st, '28/28 - 1.0s/it\n'))
    expect(st.samplingDone).toBe(true)
    expect(st.phase).toBe('sampling')
    // the VAE decode restarts the count at 1 -> a drop below prevStep -> decoding
    const r = reduceProgress(st, '1/4 - 0.3s/it\n')
    expect(r.state.phase).toBe('decoding')
    expect(r.event?.phase).toBe('decoding')
    // subsequent decode steps stay in the decoding phase
    const r2 = reduceProgress(r.state, '2/4 - 0.3s/it\n')
    expect(r2.event?.phase).toBe('decoding')
  })

  it('does NOT flip to decoding on a monotonic sampling sequence (no false transition)', () => {
    let st = initialProgressState(-1)
    ;({ state: st } = reduceProgress(st, '5/28 - 1.0s/it\n'))
    const r = reduceProgress(st, '6/28 - 1.0s/it\n')
    expect(r.event?.phase).toBe('sampling')
  })

  it('handles a malformed / partial line without throwing or emitting', () => {
    const { event } = reduceProgress(initialProgressState(-1), 'garbage 12/ - s/it partial')
    expect(event).toBeUndefined()
  })

  it('parses a negative seed (-1 fallback echoed back by the binary)', () => {
    const { state } = reduceProgress(initialProgressState(0), 'seed -1\n')
    expect(state.resolvedSeed).toBe(-1)
  })
})
