/**
 * Real SQLite coverage for the task-run persistence port. Rows in, rows out: the store must round
 * trip every optional field, tolerate legacy schemas, and refuse rows whose vocabulary the shared
 * automation package does not know. No Off Grid code is mocked.
 */
import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskHistoryStore, type TaskRunSnapshot } from '../task-history-store'

const openDatabases: Database.Database[] = []

function openStore(): { db: Database.Database; store: TaskHistoryStore } {
  const db = new Database(':memory:')
  openDatabases.push(db)
  const store = new TaskHistoryStore(db)
  store.migrate()
  return { db, store }
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close()
})

const minimal: TaskRunSnapshot = {
  taskId: 'task-minimal',
  journeyId: 'chat-1',
  kind: 'web_use',
  title: 'Book a table',
  status: 'running',
  steps: [],
  startedAt: 1_000,
  updatedAt: 1_000
}

const full: TaskRunSnapshot = {
  taskId: 'task-full',
  journeyId: 'chat-2',
  modelId: 'gemma-4',
  modelName: 'Gemma 4',
  kind: 'computer_use',
  title: 'Rename the files',
  status: 'done',
  summary: 'Renamed 3 files.',
  steps: ['Opened Finder', 'Renamed files'],
  startedAt: 2_000,
  finishedAt: 3_000,
  updatedAt: 3_000,
  executionDeviceId: 'desktop:studio',
  executionDeviceName: 'Studio Mac',
  launchId: 'launch-9',
  requestingDeviceId: 'phone-1',
  phase: 'acting' as TaskRunSnapshot['phase'],
  currentStep: 2,
  currentAction: 'click',
  currentReasoning: 'The rename button is visible.',
  reasoningLive: true,
  lastUrl: 'https://example.com',
  lastTitle: 'Example',
  screenshotPath: '/tmp/shot.png',
  screenshotDeviceId: 'desktop:studio',
  stepDetails: [
    { step: 1, kind: 'action', action: 'click', reasoning: 'Open it', at: 2_500 }
  ] as unknown as TaskRunSnapshot['stepDetails']
}

describe('TaskHistoryStore over real SQLite', () => {
  it('reads nothing from an empty table and undefined for an unknown id', () => {
    const { store } = openStore()
    expect(store.load()).toEqual([])
    expect(store.get('missing')).toBeUndefined()
  })

  it('round-trips a minimal snapshot without inventing optional fields', () => {
    const { store } = openStore()
    store.save(minimal)
    const read = store.get('task-minimal')
    expect(read).toMatchObject(minimal)
    expect(read?.stepDetails ?? []).toEqual([])
    expect(read).not.toHaveProperty('summary')
    expect(read).not.toHaveProperty('finishedAt')
    expect(read).not.toHaveProperty('reasoningLive')
    expect(store.load()).toHaveLength(1)
    expect(store.load()[0]).toMatchObject(minimal)
  })

  it('round-trips every optional field of a full snapshot', () => {
    const { store } = openStore()
    store.save(full)
    const read = store.get('task-full')
    expect(read).toBeDefined()
    const { stepDetails, ...rest } = full
    expect(read).toMatchObject(rest)
    expect(read?.stepDetails).toHaveLength(1)
    expect(read?.stepDetails?.[0]).toMatchObject({ step: 1, action: 'click' })
    void stepDetails
  })

  it('stores reasoningLive false as 0 and reads it back as false, not absent', () => {
    const { store, db } = openStore()
    store.save({ ...minimal, taskId: 'live-false', reasoningLive: false })
    const row = db
      .prepare('SELECT reasoning_live FROM task_run_history WHERE task_id = ?')
      .get('live-false') as { reasoning_live: number }
    expect(row.reasoning_live).toBe(0)
    expect(store.get('live-false')?.reasoningLive).toBe(false)
  })

  it('keeps currentStep 0 as a real step number', () => {
    const { store } = openStore()
    store.save({ ...minimal, taskId: 'step-zero', currentStep: 0 })
    expect(store.get('step-zero')?.currentStep).toBe(0)
  })

  it('updates in place on a second save and keeps started_at from the first save', () => {
    const { store } = openStore()
    store.save(minimal)
    store.save({
      ...minimal,
      status: 'done',
      summary: 'Table booked.',
      steps: ['Searched', 'Booked'],
      startedAt: 9_999,
      finishedAt: 5_000,
      updatedAt: 5_000
    })
    const read = store.get('task-minimal')
    expect(read?.status).toBe('done')
    expect(read?.summary).toBe('Table booked.')
    expect(read?.steps).toEqual(['Searched', 'Booked'])
    expect(read?.finishedAt).toBe(5_000)
    expect(read?.startedAt).toBe(1_000)
    expect(store.load()).toHaveLength(1)
  })

  it('clears an optional field when a later save omits it', () => {
    const { store } = openStore()
    store.save(full)
    const { summary, lastUrl, ...withoutSummary } = full
    void summary
    void lastUrl
    store.save(withoutSummary)
    const read = store.get('task-full')
    expect(read).not.toHaveProperty('summary')
    expect(read).not.toHaveProperty('lastUrl')
  })

  it('removes a row and tolerates removing a missing one', () => {
    const { store } = openStore()
    store.save(minimal)
    store.save(full)
    store.remove('task-minimal')
    store.remove('never-existed')
    expect(store.load().map((t) => t.taskId)).toEqual(['task-full'])
  })

  it('falls back to the task id as journey id when the row has none', () => {
    const { store, db } = openStore()
    store.save(minimal)
    db.prepare('UPDATE task_run_history SET journey_id = NULL WHERE task_id = ?').run(
      'task-minimal'
    )
    expect(store.get('task-minimal')?.journeyId).toBe('task-minimal')
  })

  it('skips rows with an unknown kind or status instead of surfacing them as tasks', () => {
    const { store, db } = openStore()
    store.save(minimal)
    store.save({ ...full, taskId: 'bad-kind' })
    store.save({ ...full, taskId: 'bad-status' })
    db.prepare("UPDATE task_run_history SET kind = 'teleport' WHERE task_id = 'bad-kind'").run()
    db.prepare("UPDATE task_run_history SET status = 'dreaming' WHERE task_id = 'bad-status'").run()
    expect(store.get('bad-kind')).toBeUndefined()
    expect(store.get('bad-status')).toBeUndefined()
    expect(store.load().map((t) => t.taskId)).toEqual(['task-minimal'])
  })

  it('reads malformed steps and step detail JSON as empty lists', () => {
    const { store, db } = openStore()
    store.save(full)
    db.prepare(
      "UPDATE task_run_history SET steps_json = 'not json', step_details_json = '{\"a\":1}' WHERE task_id = ?"
    ).run('task-full')
    const read = store.get('task-full')
    expect(read?.steps).toEqual([])
    expect(read?.stepDetails).toEqual([])
  })

  it('drops non-string entries from stored steps', () => {
    const { store, db } = openStore()
    store.save(minimal)
    db.prepare('UPDATE task_run_history SET steps_json = ? WHERE task_id = ?').run(
      JSON.stringify(['kept', 4, null, 'also kept']),
      'task-minimal'
    )
    expect(store.get('task-minimal')?.steps).toEqual(['kept', 'also kept'])
  })

  it('migrates a legacy table that lacks the newer columns and normalises stored rows', () => {
    const db = new Database(':memory:')
    openDatabases.push(db)
    db.exec(`
      CREATE TABLE task_run_history (
        task_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT,
        steps_json TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        updated_at INTEGER NOT NULL,
        last_url TEXT,
        last_title TEXT,
        screenshot_path TEXT
      )
    `)
    db.prepare(
      `INSERT INTO task_run_history (task_id, kind, title, status, steps_json, started_at, updated_at)
       VALUES ('legacy', 'web_use', 'Old task', 'done', ?, 10, 20)`
    ).run(JSON.stringify(['ok', 7, 'fine']))
    const store = new TaskHistoryStore(db)
    store.migrate()
    store.migrate()
    const legacy = store.get('legacy')
    expect(legacy).toMatchObject({
      taskId: 'legacy',
      journeyId: 'legacy',
      kind: 'web_use',
      status: 'done',
      steps: ['ok', 'fine']
    })
    const stored = db
      .prepare('SELECT steps_json, step_details_json FROM task_run_history WHERE task_id = ?')
      .get('legacy') as { steps_json: string; step_details_json: string }
    expect(stored.steps_json).toBe(JSON.stringify(['ok', 'fine']))
    expect(stored.step_details_json).toBe('[]')
    store.save(full)
    expect(store.get('task-full')?.launchId).toBe('launch-9')
  })

  it('survives migrating a partial table that has no steps columns at all', () => {
    const db = new Database(':memory:')
    openDatabases.push(db)
    db.exec(`
      CREATE TABLE task_run_history (
        task_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    const store = new TaskHistoryStore(db)
    expect(() => store.migrate()).not.toThrow()
  })
})
