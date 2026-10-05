import { describe, expect, it } from 'vitest'
import {
  encodeTaskExecutionPlan,
  encodeTaskPhase,
  type TaskExecutionPlan
} from '../../../shared/task-execution-plan'
import { browserTaskProgress, PROGRESS_STEPS } from '../task-progress'

const plan: TaskExecutionPlan = {
  version: 1,
  phases: [
    { id: 'phase-1', title: 'Open x.com' },
    { id: 'phase-2', title: 'Search for open weight models' },
    { id: 'phase-3', title: 'Read the latest posts' }
  ]
}

type Run = Parameters<typeof browserTaskProgress>[0]

const run = (steps: string[], extra: Partial<Run> = {}): Run => ({
  taskId: 'task-1',
  status: 'running',
  steps,
  ...extra
})

describe('browserTaskProgress', () => {
  it('gives the plan and the phase in progress, from the run trace', () => {
    const p = browserTaskProgress(
      run([encodeTaskExecutionPlan(plan), 'opened x.com', encodeTaskPhase('phase-2'), 'typed'])
    )
    expect(p.plan).toEqual(['Open x.com', 'Search for open weight models', 'Read the latest posts'])
    expect(p.phase).toBe(1)
    expect(p.status).toBe('running')
    expect(p.summary).toBe('')
  })

  it('sends the readable steps only, the last few, each on one bounded line', () => {
    const many = Array.from({ length: 10 }, (_, i) => `step ${i}\n  more`)
    const p = browserTaskProgress(run([encodeTaskExecutionPlan(plan), ...many, 'x'.repeat(400)]))
    expect(p.steps).toHaveLength(PROGRESS_STEPS)
    expect(p.steps.some((s) => s.startsWith('TASK '))).toBe(false)
    expect(p.steps.at(-2)).toBe('step 9 more')
    expect(p.steps.at(-1)).toHaveLength(200)
  })

  it('has no plan before one is made', () => {
    const p = browserTaskProgress(run(['starting'], { currentAction: 'Choosing the next action' }))
    expect(p.plan).toEqual([])
    expect(p.phase).toBe(-1)
    expect(p.action).toBe('Choosing the next action')
  })

  it('reports how it ended', () => {
    const p = browserTaskProgress(run([], { status: 'done', summary: 'Found 3 posts.' }))
    expect(p).toMatchObject({ status: 'done', summary: 'Found 3 posts.', taskId: 'task-1' })
  })
})
