/**
 * Real SQLite restart coverage for the shared task history projection. No
 * Off Grid AI code is mocked: a second store instance reads the same file.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TASK_HISTORY_LIMIT,
  TaskHistoryStore,
  canonicalTaskKind
} from '../tasks/task-history-store'
import { MAX_TASK_STEP_DETAILS } from '../tasks/task-step-details'

const temporaryDirectories: string[] = []

function openStore(now = 1_000): { db: Database.Database; store: TaskHistoryStore } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-task-history-'))
  temporaryDirectories.push(directory)
  const db = new Database(path.join(directory, 'history.db'))
  const store = new TaskHistoryStore(db, () => now)
  store.migrate()
  return { db, store }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('task history persistence', () => {
  it('restores Web Use state, exact logs, and the last page after a database restart', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-task-history-restart-'))
    temporaryDirectories.push(directory)
    const file = path.join(directory, 'history.db')
    const firstDb = new Database(file)
    const first = new TaskHistoryStore(firstDb, () => 1_000)
    first.migrate()
    first.upsert({
      taskId: 'legacy-web-run',
      kind: 'web_task',
      title: 'Gather proposal facts',
      status: 'failed',
      summary: 'Runtime.evaluate timed out',
      steps: ['opened https://example.com', 'clicked About'],
      lastUrl: 'https://example.com/about',
      lastTitle: 'About'
    })
    firstDb.close()

    const reopenedDb = new Database(file)
    const reopened = new TaskHistoryStore(reopenedDb, () => 2_000)
    reopened.migrate()
    expect(reopened.list()).toEqual([
      expect.objectContaining({
        taskId: 'legacy-web-run',
        kind: 'web_use',
        status: 'failed',
        summary: 'Runtime.evaluate timed out',
        steps: ['opened https://example.com', 'clicked About'],
        lastUrl: 'https://example.com/about',
        lastTitle: 'About'
      })
    ])
    reopenedDb.close()
  })

  it('closes interrupted live runs on restart without losing their state', () => {
    const { db, store } = openStore(4_000)
    store.upsert({
      taskId: 'computer-live',
      kind: 'computer_use',
      title: 'Make the deck',
      status: 'running',
      steps: ['opened Keynote'],
      screenshotPath: '/tmp/last-screen.png'
    })
    expect(store.recoverInterrupted(5_000)).toBe(1)
    expect(store.get('computer-live')).toMatchObject({
      status: 'stopped',
      finishedAt: 5_000,
      steps: ['opened Keynote'],
      screenshotPath: '/tmp/last-screen.png'
    })
    db.close()
  })

  it('bounds retained task history and accepts both legacy names', () => {
    const { db, store } = openStore()
    expect(canonicalTaskKind('web_task')).toBe('web_use')
    expect(canonicalTaskKind('computer_task')).toBe('computer_use')
    for (let index = 0; index < TASK_HISTORY_LIMIT + 3; index += 1) {
      store.upsert({
        taskId: `task-${index}`,
        kind: index % 2 ? 'web_task' : 'computer_task',
        title: `Task ${index}`,
        status: 'done',
        at: index + 1
      })
    }
    expect(store.list()).toHaveLength(TASK_HISTORY_LIMIT)
    expect(store.get('task-0')).toBeUndefined()
    db.close()
  })

  it('persists bounded and redacted Computer Use step details across a restart', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-task-details-restart-'))
    temporaryDirectories.push(directory)
    const file = path.join(directory, 'history.db')
    const firstDb = new Database(file)
    const first = new TaskHistoryStore(firstDb, () => 10_000)
    first.migrate()

    const details = Array.from({ length: MAX_TASK_STEP_DETAILS + 2 }, (_, index) => ({
      stepId: `step-${index}`,
      at: index,
      modelInput: `Open the settings. authorization: Bearer private-token-${index}`,
      screenshot: {
        path: `/tmp/frame-${index}.png`,
        originalWidth: 3024,
        originalHeight: 1964,
        inferenceWidth: 1512,
        inferenceHeight: 982
      },
      retrievedFacts: [`API_KEY=private-${index}`, 'The Settings button is visible.'],
      rawResponse: `{"action":"click","password":"private-${index}"}`,
      mappedAction: 'Click (520, 240)',
      execution: {
        status: 'complete' as const,
        durationMs: 42,
        result: 'Clicked Settings'
      }
    }))

    first.upsert({
      taskId: 'computer-details',
      kind: 'computer_use',
      title: 'Configure the app',
      status: 'done',
      stepDetails: details
    })
    firstDb.close()

    const reopenedDb = new Database(file)
    const reopened = new TaskHistoryStore(reopenedDb, () => 20_000)
    reopened.migrate()
    const restored = reopened.get('computer-details')

    expect(restored?.stepDetails).toHaveLength(MAX_TASK_STEP_DETAILS)
    expect(restored?.stepDetails?.[0]?.stepId).toBe('step-2')
    const persisted = JSON.stringify(restored?.stepDetails)
    expect(persisted).not.toContain('private-token')
    expect(persisted).not.toContain('private-2')
    expect(persisted).toContain('[redacted]')
    expect(restored?.stepDetails?.at(-1)).toMatchObject({
      mappedAction: 'Click (520, 240)',
      execution: { status: 'complete', durationMs: 42, result: 'Clicked Settings' },
      screenshot: {
        originalWidth: 3024,
        originalHeight: 1964,
        inferenceWidth: 1512,
        inferenceHeight: 982
      }
    })
    reopenedDb.close()
  })
})
