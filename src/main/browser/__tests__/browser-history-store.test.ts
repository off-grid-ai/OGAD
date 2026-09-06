import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { BrowserHistoryStore, MANUAL_BROWSER_HISTORY_LIMIT } from '../browser-history-store'
import type { TaskHistoryDatabase } from '../../tasks/task-history-store'

function store(now = () => 1_000): BrowserHistoryStore {
  const db = new DatabaseSync(':memory:') as unknown as TaskHistoryDatabase
  const history = new BrowserHistoryStore(db, now)
  history.migrate()
  history.migrate() // idempotent
  return history
}

describe('manual browser history (real SQLite)', () => {
  it('upserts by history id, names an untitled tab, and lists most recent first', () => {
    let clock = 10
    const history = store(() => clock++)
    history.upsert({ historyId: 'a', title: '  ', url: 'https://a.test' })
    history.upsert({ historyId: 'b', title: 'B', url: 'https://b.test' })
    history.upsert({ historyId: 'a', title: 'A again', url: 'https://a.test/2' })
    expect(history.get('a')).toEqual({
      historyId: 'a',
      kind: 'manual',
      status: 'closed',
      title: 'A again',
      url: 'https://a.test/2',
      updatedAt: 12
    })
    expect(history.get('missing')).toBeUndefined()
    expect(history.list().map((e) => e.historyId)).toEqual(['a', 'b'])
    expect(history.list(1).map((e) => e.historyId)).toEqual(['a'])
    expect(history.list(0)).toHaveLength(1) // the limit floors at one
  })

  it('keeps only the newest entries up to the limit', () => {
    let clock = 0
    const history = store(() => clock++)
    for (let i = 0; i < MANUAL_BROWSER_HISTORY_LIMIT + 5; i++) {
      history.upsert({ historyId: `h${i}`, title: `T${i}`, url: `https://t.test/${i}`, at: i })
    }
    const listed = history.list(MANUAL_BROWSER_HISTORY_LIMIT + 50)
    expect(listed).toHaveLength(MANUAL_BROWSER_HISTORY_LIMIT)
    expect(listed[0]!.historyId).toBe(`h${MANUAL_BROWSER_HISTORY_LIMIT + 4}`)
    expect(history.get('h0')).toBeUndefined()
  })
})
