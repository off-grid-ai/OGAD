import { describe, expect, it } from 'vitest'
import {
  decodeTaskExecutionPlan,
  decodeTaskPhase,
  decodeTaskPhaseResume,
  countTaskTraceSteps,
  encodeTaskExecutionPlan,
  encodeTaskExecutionPlanProgress,
  encodeTaskPhase,
  encodeTaskPhaseResume,
  fallbackTaskExecutionPlan,
  normalizeTaskExecutionPlan,
  taskExecutionPlanProgress
} from '../task-execution-plan'

describe('task execution plan', () => {
  it('normalizes bounded user-visible phases and round-trips the trace marker', () => {
    const plan = normalizeTaskExecutionPlan({
      phases: [' Open booking.com ', 'Set the travel filters', 'Review matching stays']
    })
    expect(plan?.phases).toEqual([
      { id: 'phase-1', title: 'Open booking.com' },
      { id: 'phase-2', title: 'Set the travel filters' },
      { id: 'phase-3', title: 'Review matching stays' }
    ])
    expect(decodeTaskExecutionPlan(encodeTaskExecutionPlan(plan!))).toEqual(plan)
  })

  it('provides a stable fallback and validates phase markers', () => {
    expect(fallbackTaskExecutionPlan('booking.com').phases[0]?.title).toBe(
      'Complete the requested work in booking.com'
    )
    expect(decodeTaskPhase(encodeTaskPhase('phase-2'))).toBe('phase-2')
    expect(decodeTaskPhase('TASK PHASE · ../../secret')).toBeNull()
    expect(
      countTaskTraceSteps([
        encodeTaskExecutionPlan(fallbackTaskExecutionPlan('booking.com')),
        encodeTaskPhase('phase-1'),
        'opened booking.com'
      ])
    ).toBe(1)
  })

  it('provides computer-use phases without web-only copy', () => {
    const plan = fallbackTaskExecutionPlan('Messages', 'computer')
    expect(plan.phases.map((phase) => phase.title)).toEqual([
      'Complete the requested work in Messages'
    ])
  })

  it('normalizes atomic operations and derives their completion evidence', () => {
    const plan = normalizeTaskExecutionPlan({
      phases: [
        { title: 'Clear search', operation: { kind: 'clear', target: ' Search ' } },
        { title: 'Type query', operation: { kind: 'type', value: ' off grid ' } },
        { title: 'Select result', operation: { kind: 'select', target: ' Result ' } },
        { title: 'Set volume', operation: { kind: 'set_value', value: ' 75 ' } },
        { title: 'Open URL', operation: { kind: 'navigate', value: ' https://example.com ' } },
        { title: 'Activate item', operation: { kind: 'activate', target: 'Save' } }
      ]
    })

    expect(plan?.phases.map((phase) => phase.completion)).toEqual([
      { kind: 'field_empty' },
      { kind: 'field_value', value: 'off grid' },
      { kind: 'selected_identity', value: 'Result' },
      { kind: 'visible_identity', value: '75' },
      { kind: 'visible_identity', value: 'https://example.com' },
      undefined
    ])
  })

  it('rejects malformed plans and restores forward-only phase progress', () => {
    expect(normalizeTaskExecutionPlan(null)).toBeNull()
    expect(normalizeTaskExecutionPlan({ phases: 'not an array' })).toBeNull()
    expect(normalizeTaskExecutionPlan({ phases: ['x', { title: '  ' }] })).toBeNull()
    expect(decodeTaskExecutionPlan('not a plan')).toBeNull()
    expect(decodeTaskExecutionPlan('TASK PLAN · {bad json')).toBeNull()

    const plan = normalizeTaskExecutionPlan({ phases: ['Open item', 'Edit item', 'Save item'] })!
    const steps = [
      ...encodeTaskExecutionPlanProgress(plan, 0),
      encodeTaskPhase('phase-3'),
      encodeTaskPhase('phase-2'),
      encodeTaskPhaseResume('phase-1')
    ]
    expect(decodeTaskPhaseResume(encodeTaskPhaseResume('phase-1'))).toBe('phase-1')
    expect(decodeTaskPhaseResume('TASK RESUME PHASE · invalid')).toBeNull()
    expect(taskExecutionPlanProgress(steps)).toEqual({ plan, activePhaseIndex: 0 })
    expect(taskExecutionPlanProgress(['ordinary action'])).toBeNull()
  })
})
