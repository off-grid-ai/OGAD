import { describe, expect, it } from 'vitest'
import { decodeTaskExecutionPlan } from '../../../shared/task-execution-plan'
import {
  createTaskExecutionPlan,
  createTaskPhaseReporter,
  prepareTaskExecutionPlan
} from '../task-execution-plan-service'

describe('task execution plan service', () => {
  it('persists one computer-use plan before any dynamic task step', async () => {
    const recorded: string[] = []
    const plan = await prepareTaskExecutionPlan(
      {
        goal: 'Send a note in Messages',
        surface: 'computer',
        targetLabel: 'Messages',
        generate: async (prompt) => {
          expect(prompt).toContain('computer-use agent')
          expect(prompt).toContain('Target app: Messages')
          return '{"phases":["Open Messages","Send the note","Verify it was sent"]}'
        }
      },
      (marker) => recorded.push(marker)
    )
    recorded.push('pressed [4] Send')

    expect(decodeTaskExecutionPlan(recorded[0] ?? '')).toEqual(plan)
    expect(recorded[1]).toBe('pressed [4] Send')
  })

  it('reports each phase once and clamps unsafe indexes', () => {
    const phases: string[] = []
    const report = createTaskPhaseReporter(
      {
        version: 1,
        phases: [
          { id: 'phase-1', title: 'Open app' },
          { id: 'phase-2', title: 'Complete work' },
          { id: 'phase-3', title: 'Verify result' }
        ]
      },
      (phase) => phases.push(phase)
    )
    report(-5)
    report(0)
    report(1)
    report(99)
    report(99)
    expect(phases).toEqual(['phase-1', 'phase-2', 'phase-3'])
  })

  it('passes cancellation to planning and does not replace Stop with a fallback plan', async () => {
    const controller = new AbortController()
    const planning = createTaskExecutionPlan({
      goal: 'Stop this Web Use task',
      surface: 'web',
      signal: controller.signal,
      generate: async (_prompt, signal) => {
        expect(signal).toBe(controller.signal)
        controller.abort(new Error('stopped from Chat'))
        signal?.throwIfAborted()
        return '{"phases":["This must not run"]}'
      }
    })

    await expect(planning).rejects.toThrow('stopped from Chat')
  })
})
