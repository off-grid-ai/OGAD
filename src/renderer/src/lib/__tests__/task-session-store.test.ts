import { describe, expect, it } from 'vitest'
import { latestTaskSession, type TaskSession } from '../task-session-store'

function task(status: TaskSession['status'], updatedAt: number): TaskSession {
  return {
    taskId: 'task-1',
    kind: 'web_use',
    title: 'Task',
    status,
    steps: [],
    startedAt: 1,
    updatedAt
  }
}

describe('latestTaskSession', () => {
  it('does not replace a newer durable failure with an older running event', () => {
    const current = task('failed', 20)
    expect(latestTaskSession(current, task('running', 10))).toBe(current)
  })

  it('keeps a terminal status when an equal-time running session is stale', () => {
    expect(latestTaskSession(task('failed', 20), task('running', 20)).status).toBe('failed')
  })

  it('accepts a genuinely newer retry state', () => {
    expect(latestTaskSession(task('failed', 20), task('running', 21)).status).toBe('running')
  })
})
