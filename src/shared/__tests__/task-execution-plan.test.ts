import { describe, expect, it } from 'vitest'
import {
  decodeTaskExecutionPlan,
  decodeTaskPhase,
  countTaskTraceSteps,
  encodeTaskExecutionPlan,
  encodeTaskPhase,
  fallbackTaskExecutionPlan,
  normalizeTaskExecutionPlan
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
    expect(fallbackTaskExecutionPlan('booking.com').phases[0]?.title).toBe('Open booking.com')
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
      'Open Messages',
      'Complete the requested work',
      'Verify the result'
    ])
  })
})
