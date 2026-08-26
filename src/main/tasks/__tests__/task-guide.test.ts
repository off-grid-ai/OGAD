import { describe, expect, it } from 'vitest'
import { persistedTaskGuidanceTrace } from '../task-guide'

describe('persisted task guidance', () => {
  it('never puts the exact user text into task history or sync', () => {
    const privateGuidance = 'Use password=hunter2 and Bearer private-token'
    const trace = persistedTaskGuidanceTrace()
    expect(trace).toBe('GUIDANCE ACCEPTED · Applying to the next decision.')
    expect(trace).not.toContain(privateGuidance)
    expect(trace).not.toContain('hunter2')
    expect(trace).not.toContain('private-token')
  })
})
