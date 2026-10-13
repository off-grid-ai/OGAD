import { describe, expect, it } from 'vitest'
import {
  encodeTaskExecutionPlan,
  encodeTaskPhase,
  type TaskExecutionPlan
} from '../../../shared/task-execution-plan'
import {
  browserTaskById,
  createAcceptedTasks,
  latestBrowserTask,
  stopRoute
} from '../bridge-task-progress'

const plan: TaskExecutionPlan = {
  version: 1,
  phases: [
    { id: 'phase-1', title: 'Search the shop for boots' },
    { id: 'phase-2', title: 'Report the first result' }
  ]
}

type Row = Parameters<typeof latestBrowserTask>[0][number]

const row = (over: Partial<Row> = {}): Row => ({
  taskId: 'task-1',
  journeyId: 'browser:a',
  status: 'running',
  summary: '',
  startedAt: 100,
  currentAction: 'Typing boots',
  steps: [
    encodeTaskExecutionPlan(plan),
    'working in your tab in Chrome',
    encodeTaskPhase('phase-2'),
    'read the results'
  ],
  ...over
})

describe("a browser's view of the web task it started", () => {
  it('carries the task id, plan titles, phase, trace steps and current action', () => {
    expect(latestBrowserTask([row()], 'browser:a', 50)).toEqual({
      taskId: 'task-1',
      status: 'running',
      summary: '',
      plan: ['Search the shop for boots', 'Report the first result'],
      phase: 1,
      steps: ['working in your tab in Chrome', 'read the results'],
      action: 'Typing boots'
    })
  })

  it('has no plan or action before planning and once the task ends', () => {
    expect(latestBrowserTask([row({ steps: [] })], 'browser:a', 0)).toMatchObject({
      plan: [],
      phase: -1,
      steps: []
    })
    expect(
      latestBrowserTask([row({ status: 'done', summary: 'Found boots.' })], 'browser:a', 0)
    ).toMatchObject({ status: 'done', summary: 'Found boots.', action: '' })
  })

  it("sees only this browser's tasks since the time asked, newest started first", () => {
    const runs = [
      row({ taskId: 'older', startedAt: 120 }),
      row({ taskId: 'other-browser', journeyId: 'browser:b', startedAt: 500 }),
      row({ taskId: 'newer', startedAt: 300 })
    ]
    expect(latestBrowserTask(runs, 'browser:a', 0)?.taskId).toBe('newer')
    expect(latestBrowserTask(runs, 'browser:a', 400)).toBeNull()
    expect(latestBrowserTask(runs, 'browser:c', 0)).toBeNull()
  })

  it('follows the task a chat asked for, though a newer one started since', () => {
    // Review finding: chat A lost its task once chat B started a newer one.
    const runs = [
      row({ taskId: 'a-task', startedAt: 120 }),
      row({ taskId: 'b-task', startedAt: 300 })
    ]
    expect(latestBrowserTask(runs, 'browser:a', 0, 'a-task')?.taskId).toBe('a-task')
    expect(latestBrowserTask(runs, 'browser:b', 0, 'a-task')).toBeNull()
  })
})

describe('a browser task by its own id', () => {
  const journey = 'browser:chrome-1'
  it("shows a task given to this browser as queued until it starts, and nobody else's", () => {
    // Review finding: with no history row yet the bridge returned nothing, and chats fell back to
    // the newest task of the shared browser journey.
    const accepted = createAcceptedTasks()
    accepted.remember('act_a', journey)
    expect(browserTaskById(null, accepted, journey, 0, 'act_a')).toMatchObject({
      taskId: 'act_a',
      status: 'queued'
    })
    expect(browserTaskById(null, accepted, 'browser:other', 0, 'act_a')).toBeNull()
    expect(browserTaskById(null, accepted, journey, 0, 'act_b')).toBeNull()
  })

  it('stops a running task through its session, a queued one before it starts, and no other', () => {
    const accepted = createAcceptedTasks()
    accepted.remember('act_a', journey)
    expect(stopRoute({ journeyId: journey }, accepted, journey, 'act_a')).toBe('running')
    expect(stopRoute(null, accepted, journey, 'act_a')).toBe('before-start')
    expect(stopRoute({ journeyId: 'browser:other' }, accepted, journey, 'act_a')).toBeNull()
    expect(stopRoute(null, accepted, journey, 'act_unknown')).toBeNull()
  })

  it('remembers a bounded number of ids, forgetting the oldest', () => {
    const accepted = createAcceptedTasks(2)
    accepted.remember('one', journey)
    accepted.remember('two', journey)
    accepted.remember('three', journey)
    expect(accepted.owns('one', journey)).toBe(false)
    expect(accepted.owns('three', journey)).toBe(true)
  })
})
