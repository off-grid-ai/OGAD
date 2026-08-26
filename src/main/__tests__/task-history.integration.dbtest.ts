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
  ORPHANED_LOCAL_WEB_TASK_SUMMARY,
  TASK_HISTORY_LIMIT,
  TaskHistoryStore,
  canonicalTaskKind
} from '../tasks/task-history-store'
import { MAX_TASK_STEP_DETAILS } from '../tasks/task-step-details'
import { MAX_COMPUTER_USE_REASONING_CHARS } from '../../shared/computer-use-limits'
import { encodeTaskExecutionPlan, encodeTaskPhase } from '../../shared/task-execution-plan'

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
  it('keeps the execution plan when a Computer Use checkpoint updates the run', () => {
    const { db, store } = openStore(4_000)
    const plan = encodeTaskExecutionPlan({
      version: 1,
      phases: [
        { id: 'phase-1', title: 'Open the app' },
        { id: 'phase-2', title: 'Complete the form' }
      ]
    })
    store.upsert({
      taskId: 'computer-plan-checkpoint',
      kind: 'computer_use',
      title: 'Complete the form',
      status: 'running',
      steps: [plan, encodeTaskPhase('phase-1'), 'opened the app']
    })

    // Checkpoints update liveness only. Their action-local step array must not
    // replace the canonical trace with a plan-free list.
    store.upsert({
      taskId: 'computer-plan-checkpoint',
      kind: 'computer_use',
      title: 'Complete the form'
    })

    expect(store.get('computer-plan-checkpoint')?.steps).toEqual([
      plan,
      encodeTaskPhase('phase-1'),
      'opened the app'
    ])
    db.close()
  })

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

  it('migrates and keeps the exact run model after the active model changes', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-task-model-migration-'))
    temporaryDirectories.push(directory)
    const file = path.join(directory, 'history.db')
    const firstDb = new Database(file)
    firstDb.exec(`
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
    firstDb
      .prepare(
        `INSERT INTO task_run_history (
           task_id, kind, title, status, started_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('model-owned-run', 'web_use', 'Find a flight', 'running', 1_000, 1_000)

    const migrated = new TaskHistoryStore(firstDb, () => 2_000)
    migrated.migrate()
    migrated.upsert({
      taskId: 'model-owned-run',
      kind: 'web_use',
      modelId: 'qwen-vision',
      modelName: 'Qwen Vision 9B'
    })
    migrated.upsert({
      taskId: 'model-owned-run',
      kind: 'web_use',
      modelId: 'gemma-vision',
      modelName: 'Gemma Vision 12B',
      at: 3_000
    })
    firstDb.close()

    const reopenedDb = new Database(file)
    const reopened = new TaskHistoryStore(reopenedDb, () => 4_000)
    reopened.migrate()
    expect(reopened.get('model-owned-run')).toMatchObject({
      modelId: 'qwen-vision',
      modelName: 'Qwen Vision 9B',
      updatedAt: 3_000
    })
    const raw = reopenedDb
      .prepare('SELECT model_id, model_name FROM task_run_history WHERE task_id = ?')
      .get('model-owned-run') as { model_id: string; model_name: string }
    expect(raw).toEqual({ model_id: 'qwen-vision', model_name: 'Qwen Vision 9B' })
    reopenedDb.close()
  })

  it('migrates and restores bounded Web Use reasoning without adding it to the trace', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-task-reasoning-migration-'))
    temporaryDirectories.push(directory)
    const file = path.join(directory, 'history.db')
    const firstDb = new Database(file)
    firstDb.exec(`
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

    const migrated = new TaskHistoryStore(firstDb, () => 2_000)
    migrated.migrate()
    const secret = 'private-form-value-839201'
    const streamed = `${'context '.repeat(2_000)}The field is ready. type "${secret}". api_key=private-api-key-839201`
    migrated.upsert({
      taskId: 'web-reasoning-run',
      journeyId: 'conversation-a',
      kind: 'web_use',
      title: 'Find a flight',
      status: 'running',
      steps: ['opened the flight search page'],
      currentReasoning: streamed,
      reasoningLive: true
    })
    expect(migrated.get('web-reasoning-run')?.reasoningLive).toBe(true)
    migrated.upsert({
      taskId: 'web-reasoning-run',
      kind: 'web_use',
      currentReasoning: streamed,
      reasoningLive: false,
      at: 3_000
    })
    migrated.upsert({
      taskId: 'native-reasoning-run',
      kind: 'computer_use',
      title: 'Edit the deck',
      status: 'running',
      currentReasoning: 'This must remain Web Use-only.',
      reasoningLive: true
    })
    firstDb.close()

    const reopenedDb = new Database(file)
    const reopened = new TaskHistoryStore(reopenedDb, () => 4_000)
    reopened.migrate()
    const web = reopened.get('web-reasoning-run')
    expect(web).toMatchObject({
      journeyId: 'conversation-a',
      reasoningLive: false,
      steps: ['opened the flight search page']
    })
    expect(web?.currentReasoning?.length).toBeLessThanOrEqual(MAX_COMPUTER_USE_REASONING_CHARS)
    expect(web?.currentReasoning).toContain('[redacted]')
    expect(web?.currentReasoning).not.toContain(secret)
    expect(reopened.get('native-reasoning-run')).not.toHaveProperty('currentReasoning')
    expect(reopened.get('native-reasoning-run')).not.toHaveProperty('reasoningLive')
    const raw = reopenedDb
      .prepare(
        'SELECT current_reasoning, reasoning_live, steps_json FROM task_run_history WHERE task_id = ?'
      )
      .get('web-reasoning-run') as {
      current_reasoning: string
      reasoning_live: number
      steps_json: string
    }
    expect(raw.reasoning_live).toBe(0)
    expect(raw.steps_json).toBe('["opened the flight search page"]')
    expect(raw.current_reasoning).not.toContain(secret)
    reopenedDb.close()
  })

  it('closes interrupted live runs on restart without losing their state', () => {
    const { db, store } = openStore(4_000)
    store.upsert({
      taskId: 'computer-live',
      kind: 'computer_use',
      title: 'Make the deck',
      status: 'running',
      executionDeviceId: 'studio-mac',
      executionDeviceName: 'Studio Mac',
      steps: ['opened Keynote'],
      screenshotPath: '/tmp/last-screen.png'
    })
    expect(store.recoverInterrupted('studio-mac', 5_000)).toBe(1)
    expect(store.get('computer-live')).toMatchObject({
      status: 'stopped',
      finishedAt: 5_000,
      steps: ['opened Keynote'],
      screenshotPath: '/tmp/last-screen.png'
    })
    db.close()
  })

  it('stops one orphaned local Web Use run without changing remote or native runs', () => {
    const { db, store } = openStore(4_000)
    store.upsert({
      taskId: 'local-web',
      journeyId: 'chat-local',
      kind: 'web_use',
      title: 'Find a flight',
      status: 'running',
      executionDeviceId: 'studio-mac',
      steps: ['opened the search page'],
      currentReasoning: 'The search page is visible.',
      reasoningLive: true
    })
    store.upsert({
      taskId: 'remote-web',
      kind: 'web_use',
      title: 'Check another site',
      status: 'running',
      executionDeviceId: 'travel-mac'
    })
    store.upsert({
      taskId: 'local-computer',
      kind: 'computer_use',
      title: 'Update the app',
      status: 'running',
      executionDeviceId: 'studio-mac'
    })

    expect(store.stopOrphanedLocalWebTask('local-web', 'studio-mac', 5_000)).toMatchObject({
      taskId: 'local-web',
      journeyId: 'chat-local',
      status: 'stopped',
      phase: 'stopped',
      finishedAt: 5_000,
      summary: ORPHANED_LOCAL_WEB_TASK_SUMMARY,
      steps: ['opened the search page'],
      currentReasoning: 'The search page is visible.',
      reasoningLive: false
    })
    expect(store.stopOrphanedLocalWebTask('remote-web', 'studio-mac', 5_000)).toBeUndefined()
    expect(store.stopOrphanedLocalWebTask('local-computer', 'studio-mac', 5_000)).toBeUndefined()
    expect(store.get('remote-web')?.status).toBe('running')
    expect(store.get('local-computer')?.status).toBe('running')
    db.close()
  })

  it('removes legacy private guidance before history or sync can read it', () => {
    const { db, store } = openStore(4_000)
    const privateGuidance = 'USER GUIDANCE · password=hunter2 and token=private-839201'
    store.upsert({
      taskId: 'legacy-guidance',
      kind: 'web_use',
      title: 'Private task',
      status: 'running',
      steps: [privateGuidance, 'clicked Continue']
    })

    expect(store.get('legacy-guidance')?.steps).toEqual([
      'GUIDANCE ACCEPTED · Applying to the next decision.',
      'clicked Continue'
    ])
    const raw = db
      .prepare('SELECT steps_json FROM task_run_history WHERE task_id = ?')
      .get('legacy-guidance') as { steps_json: string }
    expect(raw.steps_json).not.toContain('hunter2')
    expect(raw.steps_json).not.toContain('private-839201')
    db.close()
  })

  it('redacts guidance written by an older build during migration', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-task-guidance-migration-'))
    temporaryDirectories.push(directory)
    const file = path.join(directory, 'history.db')
    const firstDb = new Database(file)
    const first = new TaskHistoryStore(firstDb, () => 1_000)
    first.migrate()
    first.upsert({
      taskId: 'old-build-task',
      kind: 'web_use',
      title: 'Old build task',
      status: 'done',
      steps: ['clicked Continue']
    })
    firstDb
      .prepare('UPDATE task_run_history SET steps_json = ? WHERE task_id = ?')
      .run(JSON.stringify(['USER GUIDANCE · secret-private-839201']), 'old-build-task')
    firstDb.close()

    const reopenedDb = new Database(file)
    const reopened = new TaskHistoryStore(reopenedDb, () => 2_000)
    reopened.migrate()
    expect(reopened.get('old-build-task')?.steps).toEqual([
      'GUIDANCE ACCEPTED · Applying to the next decision.'
    ])
    const raw = reopenedDb
      .prepare('SELECT steps_json FROM task_run_history WHERE task_id = ?')
      .get('old-build-task') as { steps_json: string }
    expect(raw.steps_json).not.toContain('secret-private-839201')
    reopenedDb.close()
  })

  it('recovers only runs owned by this device and leaves remote runs live', () => {
    const { db, store } = openStore(4_000)
    store.upsert({
      taskId: 'local-run',
      journeyId: 'chat-local',
      kind: 'computer_use',
      title: 'Local task',
      status: 'running',
      executionDeviceId: 'studio-mac',
      executionDeviceName: 'Studio Mac'
    })
    store.upsert({
      taskId: 'remote-run',
      journeyId: 'chat-remote',
      kind: 'computer_use',
      title: 'Remote task',
      status: 'running',
      executionDeviceId: 'travel-mac',
      executionDeviceName: 'Travel Mac'
    })
    store.upsert({
      taskId: 'legacy-local-run',
      kind: 'computer_use',
      title: 'Legacy local task',
      status: 'paused'
    })

    expect(store.recoverInterrupted('studio-mac', 5_000)).toBe(2)
    expect(store.get('local-run')).toMatchObject({ status: 'stopped', finishedAt: 5_000 })
    expect(store.get('legacy-local-run')).toMatchObject({ status: 'stopped', finishedAt: 5_000 })
    expect(store.get('remote-run')).toMatchObject({
      status: 'running',
      journeyId: 'chat-remote',
      executionDeviceId: 'travel-mac',
      executionDeviceName: 'Travel Mac'
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
      phase: 'acting' as const,
      screenshot: {
        path: `/tmp/frame-${index}.png`,
        availability: 'device_local' as const,
        executionDeviceId: 'studio-mac',
        executionDeviceName: 'Studio Mac',
        originalWidth: 3024,
        originalHeight: 1964,
        inferenceWidth: 1512,
        inferenceHeight: 982
      },
      retrievedFacts: [`API_KEY=private-${index}`, 'The Settings button is visible.'],
      decisionSummary: 'Open Settings',
      rawResponse: `<think>hidden reasoning ${index}</think><action>Open Settings</action><tool_call>{"action":"click","password":"private-${index}"}</tool_call>`,
      mappedAction: 'Click (520, 240)',
      execution: {
        status: 'complete' as const,
        durationMs: 42,
        result: 'Clicked Settings'
      }
    }))

    first.upsert({
      taskId: 'computer-details',
      journeyId: 'conversation-42',
      kind: 'computer_use',
      title: 'Configure the app',
      status: 'done',
      executionDeviceId: 'studio-mac',
      executionDeviceName: 'Studio Mac',
      phase: 'complete',
      currentStep: details.length,
      currentAction: 'Configured the app',
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
    expect(persisted).not.toContain('hidden reasoning')
    expect(persisted).toContain('[redacted]')
    expect(restored).toMatchObject({
      journeyId: 'conversation-42',
      executionDeviceId: 'studio-mac',
      executionDeviceName: 'Studio Mac',
      phase: 'complete',
      currentStep: details.length,
      currentAction: 'Configured the app'
    })
    expect(restored?.stepDetails?.at(-1)).toMatchObject({
      phase: 'acting',
      decisionSummary: 'Open Settings',
      modelOutput: expect.stringContaining('<action>Open Settings</action>'),
      mappedAction: 'Click (520, 240)',
      execution: { status: 'complete', durationMs: 42, result: 'Clicked Settings' },
      screenshot: {
        availability: 'device_local',
        executionDeviceId: 'studio-mac',
        executionDeviceName: 'Studio Mac',
        originalWidth: 3024,
        originalHeight: 1964,
        inferenceWidth: 1512,
        inferenceHeight: 982
      }
    })
    reopenedDb.close()
  })

  it('never persists arbitrary typed text in Computer Use audit fields', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-task-typed-secret-'))
    temporaryDirectories.push(directory)
    const database = new Database(path.join(directory, 'history.db'))
    const history = new TaskHistoryStore(database, () => 10_000)
    history.migrate()

    const secret = '839201-private-value'
    history.upsert({
      taskId: 'typed-secret',
      kind: 'computer_use',
      title: 'Complete the form',
      status: 'failed',
      steps: ['typed text into the focused field'],
      stepDetails: [
        {
          stepId: '1',
          at: 1,
          modelInput: `Earlier action: type(content='${secret}')`,
          rawResponse: `Thought: use the supplied value\nAction: type(content='${secret}')`,
          decisionSummary: `type "${secret}"`,
          mappedAction: JSON.stringify({ type: 'type', content: secret }),
          execution: { status: 'complete', result: 'actuated' }
        },
        {
          stepId: '2',
          at: 2,
          rawResponse: JSON.stringify({ action: 'type', text: secret }),
          mappedAction: JSON.stringify({ action: 'type', text: secret })
        }
      ]
    })

    const durableRow = database
      .prepare('SELECT steps_json, step_details_json FROM task_run_history WHERE task_id = ?')
      .get('typed-secret') as { steps_json: string; step_details_json: string }
    const durable = JSON.stringify(durableRow)
    expect(durable).not.toContain(secret)
    expect(durable).toContain('[redacted]')
    database.close()
  })
})
