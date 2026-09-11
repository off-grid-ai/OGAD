import { describe, expect, it } from 'vitest'
import { createStartupProjection } from '../startup-projection'

describe('startup projection', () => {
  it('returns to ready when every running stage completes', () => {
    const projection = createStartupProjection()

    projection.stageStarted({ name: 'core', required: true })
    projection.stageStarted({ name: 'optional', required: false })
    expect(projection.snapshot().phase).toBe('pending')
    expect(projection.snapshot().running).toEqual(['core', 'optional'])

    projection.stageSettled({
      name: 'core',
      status: 'completed',
      required: true,
      durationMs: 4
    })
    projection.stageSettled({
      name: 'optional',
      status: 'completed',
      required: false,
      durationMs: 8
    })

    expect(projection.snapshot()).toMatchObject({ phase: 'ready', running: [] })
  })

  it('keeps required failures distinct from optional degradation', () => {
    const optional = createStartupProjection()
    optional.stageSettled({
      name: 'optional',
      status: 'timeout',
      required: false,
      durationMs: 20,
      error: 'exceeded 20ms'
    })
    expect(optional.snapshot().phase).toBe('degraded')

    const required = createStartupProjection()
    required.stageSettled({
      name: 'required',
      status: 'failed',
      required: true,
      durationMs: 2,
      error: 'failed'
    })
    expect(required.snapshot().phase).toBe('failed')
  })

  it('publishes increasing revisions and stops after unsubscribe', () => {
    const projection = createStartupProjection()
    const revisions: number[] = []
    const unsubscribe = projection.subscribe((snapshot) => revisions.push(snapshot.revision))

    projection.stageStarted({ name: 'core', required: true })
    projection.stageSettled({
      name: 'core',
      status: 'completed',
      required: true,
      durationMs: 1
    })
    unsubscribe()
    projection.stageStarted({ name: 'later', required: false })

    expect(revisions).toEqual([1, 2])
  })
})
