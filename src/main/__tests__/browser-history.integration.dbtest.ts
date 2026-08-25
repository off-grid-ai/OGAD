import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserHistoryStore, MANUAL_BROWSER_HISTORY_LIMIT } from '../browser/browser-history-store'
import { TaskHistoryStore } from '../tasks/task-history-store'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('manual browser history persistence', () => {
  it('restores a closed manual page after a database restart without making it a task', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-browser-history-'))
    temporaryDirectories.push(directory)
    const file = path.join(directory, 'history.db')
    const firstDb = new Database(file)
    const first = new BrowserHistoryStore(firstDb, () => 1_000)
    first.migrate()
    const tasks = new TaskHistoryStore(firstDb, () => 1_000)
    tasks.migrate()
    first.upsert({
      historyId: 'manual-1',
      title: 'Example documentation',
      url: 'https://example.com/docs'
    })
    expect(tasks.list()).toEqual([])
    firstDb.close()

    const reopenedDb = new Database(file)
    const reopened = new BrowserHistoryStore(reopenedDb, () => 2_000)
    reopened.migrate()
    expect(reopened.list()).toEqual([
      {
        historyId: 'manual-1',
        kind: 'manual',
        status: 'closed',
        title: 'Example documentation',
        url: 'https://example.com/docs',
        updatedAt: 1_000
      }
    ])
    reopenedDb.close()
  })

  it('updates the last page and bounds retained recents', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-browser-history-limit-'))
    temporaryDirectories.push(directory)
    const db = new Database(path.join(directory, 'history.db'))
    const store = new BrowserHistoryStore(db)
    store.migrate()
    store.upsert({ historyId: 'same', title: 'First', url: 'https://example.com', at: 1 })
    store.upsert({ historyId: 'same', title: 'Second', url: 'https://example.com/two', at: 2 })
    for (let index = 0; index < MANUAL_BROWSER_HISTORY_LIMIT + 2; index += 1) {
      store.upsert({
        historyId: `manual-${index}`,
        title: `Page ${index}`,
        url: `https://example.com/${index}`,
        at: index + 3
      })
    }

    expect(store.list()).toHaveLength(MANUAL_BROWSER_HISTORY_LIMIT)
    expect(store.get('same')).toBeUndefined()
    expect(store.get(`manual-${MANUAL_BROWSER_HISTORY_LIMIT + 1}`)?.title).toBe(
      `Page ${MANUAL_BROWSER_HISTORY_LIMIT + 1}`
    )
    db.close()
  })
})
