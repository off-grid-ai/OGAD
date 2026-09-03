import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const h = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof import('node:sqlite').DatabaseSync> }))
vi.mock('../../database', () => ({ getDB: () => h.db }))

import { recentVisualFacts } from '../visual-context'

beforeEach(() => {
  h.db = new DatabaseSync(':memory:')
})

describe('recent visual facts for Computer Use', () => {
  it('returns bounded text facts from other completed runs, newest first, never screenshots', () => {
    h.db.exec(`CREATE TABLE task_run_history (task_id TEXT, kind TEXT, status TEXT, title TEXT, summary TEXT, steps_json TEXT, updated_at INTEGER)`)
    const insert = h.db.prepare('INSERT INTO task_run_history VALUES (?, ?, ?, ?, ?, ?, ?)')
    insert.run('me', 'computer_use', 'done', 'Current', 'ignored', '[]', 9)
    insert.run('t1', 'computer_use', 'done', 'Open mail', 'Inbox opened', '[]', 5)
    insert.run('t2', 'computer_use', 'failed', 'Fill form', null, '["typed name","typed email","clicked submit","saw error"]', 6)
    insert.run('t3', 'computer_use', 'stopped', 'Empty', null, 'not json', 7)
    insert.run('t4', 'computer_use', 'running', 'Live', 'still going', '[]', 8)
    insert.run('t5', 'browser', 'done', 'Not computer use', 'x', '[]', 8)
    expect(recentVisualFacts('me')).toEqual([
      'Empty: No outcome saved.',
      'Fill form: typed email; clicked submit; saw error',
      'Open mail: Inbox opened'
    ])
    expect(recentVisualFacts('me', 1)).toEqual(['Empty: No outcome saved.'])
    expect(recentVisualFacts('me', 0)).toEqual([])
    expect(recentVisualFacts('me', 99)).toHaveLength(3) // capped at five, only three qualify
  })

  it('is an optional enhancement: a profile without task history yields nothing instead of failing', () => {
    expect(recentVisualFacts('me')).toEqual([])
  })
})
