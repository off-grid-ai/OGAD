/**
 * SQLite rows for task runs: the persistence port `AutomationApplication` (`@offgrid/automation`)
 * writes through. Rows in, rows out. Every decision - what an update may change, when a task is
 * interrupted or orphaned, how much history is kept - is made in shared before `save`.
 *
 * Browser and computer-use hosts write through the one application; the renderer reads the same
 * rows after a restart, so live tabs and history cannot drift into separate persistence systems.
 */
import {
  boundComputerUseStepDetails,
  parseAutomationTaskKind,
  parseAutomationTaskReadStatus,
  storedComputerUseStepDetails,
  storedTaskSteps,
  type ComputerUsePhase,
  type TaskHistoryPersistencePort,
  type TaskRunSnapshot
} from '@offgrid/automation'

export type {
  TaskRunKind,
  TaskRunSnapshot,
  TaskRunStatus,
  TaskRunUpdate
} from '@offgrid/automation'
export { ORPHANED_LOCAL_WEB_TASK_SUMMARY, TASK_HISTORY_LIMIT } from '@offgrid/automation'

interface StatementLike {
  run(...params: unknown[]): { changes: number }
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export interface TaskHistoryDatabase {
  exec(sql: string): void
  prepare(sql: string): StatementLike
}

interface TaskRunRow {
  task_id: string
  journey_id?: string | null
  model_id?: string | null
  model_name?: string | null
  kind: string
  title: string
  status: string
  summary: string | null
  steps_json: string
  started_at: number
  finished_at: number | null
  updated_at: number
  execution_device_id?: string | null
  execution_device_name?: string | null
  launch_id?: string | null
  requesting_device_id?: string | null
  phase?: string | null
  current_step?: number | null
  current_action?: string | null
  current_reasoning?: string | null
  reasoning_live?: number | null
  last_url: string | null
  last_title: string | null
  screenshot_path: string | null
  screenshot_device_id?: string | null
  step_details_json?: string | null
}

/** A row as the shared snapshot; a row with an unknown vocabulary is not a task. */
function rowToSnapshot(row: TaskRunRow): TaskRunSnapshot | undefined {
  const kind = parseAutomationTaskKind(row.kind)
  const status = parseAutomationTaskReadStatus(row.status)
  if (!kind || !status) return undefined
  return {
    taskId: row.task_id,
    journeyId: row.journey_id || row.task_id,
    ...(row.model_id ? { modelId: row.model_id } : {}),
    ...(row.model_name ? { modelName: row.model_name } : {}),
    kind,
    title: row.title,
    status,
    ...(row.summary ? { summary: row.summary } : {}),
    steps: storedTaskSteps(row.steps_json),
    startedAt: row.started_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    updatedAt: row.updated_at,
    ...(row.execution_device_id ? { executionDeviceId: row.execution_device_id } : {}),
    ...(row.execution_device_name ? { executionDeviceName: row.execution_device_name } : {}),
    ...(row.launch_id ? { launchId: row.launch_id } : {}),
    ...(row.requesting_device_id ? { requestingDeviceId: row.requesting_device_id } : {}),
    ...(row.phase ? { phase: row.phase as ComputerUsePhase } : {}),
    ...(typeof row.current_step === 'number' ? { currentStep: row.current_step } : {}),
    ...(row.current_action ? { currentAction: row.current_action } : {}),
    ...(row.current_reasoning ? { currentReasoning: row.current_reasoning } : {}),
    ...(row.reasoning_live === 0 || row.reasoning_live === 1
      ? { reasoningLive: row.reasoning_live === 1 }
      : {}),
    ...(row.last_url ? { lastUrl: row.last_url } : {}),
    ...(row.last_title ? { lastTitle: row.last_title } : {}),
    ...(row.screenshot_path ? { screenshotPath: row.screenshot_path } : {}),
    ...(row.screenshot_device_id ? { screenshotDeviceId: row.screenshot_device_id } : {}),
    ...(row.step_details_json
      ? { stepDetails: storedComputerUseStepDetails(row.step_details_json) }
      : {})
  }
}

export class TaskHistoryStore implements TaskHistoryPersistencePort {
  constructor(private readonly db: TaskHistoryDatabase) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_run_history (
        task_id TEXT PRIMARY KEY,
        journey_id TEXT,
        model_id TEXT,
        model_name TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT,
        steps_json TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        updated_at INTEGER NOT NULL,
        execution_device_id TEXT,
        execution_device_name TEXT,
        launch_id TEXT,
        requesting_device_id TEXT,
        phase TEXT,
        current_step INTEGER,
        current_action TEXT,
        current_reasoning TEXT,
        reasoning_live INTEGER,
        last_url TEXT,
        last_title TEXT,
        screenshot_path TEXT,
        screenshot_device_id TEXT,
        step_details_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS task_run_history_recent
        ON task_run_history (updated_at DESC);
    `)
    for (const column of [
      'journey_id TEXT',
      'execution_device_id TEXT',
      'execution_device_name TEXT',
      'launch_id TEXT',
      'requesting_device_id TEXT',
      'model_id TEXT',
      'model_name TEXT',
      'phase TEXT',
      'current_step INTEGER',
      'current_action TEXT',
      'current_reasoning TEXT',
      'reasoning_live INTEGER',
      'screenshot_device_id TEXT',
      "step_details_json TEXT NOT NULL DEFAULT '[]'"
    ]) {
      try {
        this.db.exec(`ALTER TABLE task_run_history ADD COLUMN ${column}`)
      } catch {
        // Existing databases may already have the column.
      }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS task_run_history_journey
        ON task_run_history (journey_id, updated_at DESC)
    `)
    // Early guidance builds stored the exact user text; earlier Computer Use builds stored model
    // sentinel strings. Normalise existing rows through the shared boundaries once, so neither can
    // enter history or cross-device sync.
    try {
      const rows = this.db
        .prepare('SELECT task_id, steps_json, step_details_json FROM task_run_history')
        .all() as Array<{ task_id: string; steps_json: string; step_details_json: string }>
      const update = this.db.prepare(
        'UPDATE task_run_history SET steps_json = ?, step_details_json = ? WHERE task_id = ?'
      )
      for (const row of rows) {
        const steps = JSON.stringify(storedTaskSteps(row.steps_json))
        const details = JSON.stringify(
          boundComputerUseStepDetails(storedComputerUseStepDetails(row.step_details_json))
        )
        if (steps !== row.steps_json || details !== row.step_details_json) {
          update.run(steps, details, row.task_id)
        }
      }
    } catch {
      // Keep migration compatible with partial test databases.
    }
  }

  load(): TaskRunSnapshot[] {
    return (this.db.prepare('SELECT * FROM task_run_history').all() as TaskRunRow[]).flatMap(
      (row) => {
        const snapshot = rowToSnapshot(row)
        return snapshot ? [snapshot] : []
      }
    )
  }

  get(taskId: string): TaskRunSnapshot | undefined {
    const row = this.db.prepare('SELECT * FROM task_run_history WHERE task_id = ?').get(taskId) as
      | TaskRunRow
      | undefined
    return row ? rowToSnapshot(row) : undefined
  }

  save(snapshot: TaskRunSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO task_run_history (
           task_id, journey_id, model_id, model_name, kind, title, status, summary, steps_json, started_at,
           finished_at, updated_at, execution_device_id, execution_device_name, launch_id,
           requesting_device_id, phase,
           current_step, current_action, current_reasoning, reasoning_live, last_url, last_title, screenshot_path,
           screenshot_device_id, step_details_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           journey_id = excluded.journey_id,
           model_id = excluded.model_id,
           model_name = excluded.model_name,
           kind = excluded.kind,
           title = excluded.title,
           status = excluded.status,
           summary = excluded.summary,
           steps_json = excluded.steps_json,
           finished_at = excluded.finished_at,
           updated_at = excluded.updated_at,
           execution_device_id = excluded.execution_device_id,
           execution_device_name = excluded.execution_device_name,
           launch_id = excluded.launch_id,
           requesting_device_id = excluded.requesting_device_id,
           phase = excluded.phase,
           current_step = excluded.current_step,
           current_action = excluded.current_action,
           current_reasoning = excluded.current_reasoning,
           reasoning_live = excluded.reasoning_live,
           last_url = excluded.last_url,
           last_title = excluded.last_title,
           screenshot_path = excluded.screenshot_path,
           screenshot_device_id = excluded.screenshot_device_id,
           step_details_json = excluded.step_details_json`
      )
      .run(
        snapshot.taskId,
        snapshot.journeyId,
        snapshot.modelId ?? null,
        snapshot.modelName ?? null,
        snapshot.kind,
        snapshot.title,
        snapshot.status,
        snapshot.summary ?? null,
        JSON.stringify(snapshot.steps),
        snapshot.startedAt,
        snapshot.finishedAt ?? null,
        snapshot.updatedAt,
        snapshot.executionDeviceId ?? null,
        snapshot.executionDeviceName ?? null,
        snapshot.launchId ?? null,
        snapshot.requestingDeviceId ?? null,
        snapshot.phase ?? null,
        snapshot.currentStep ?? null,
        snapshot.currentAction ?? null,
        snapshot.currentReasoning ?? null,
        snapshot.reasoningLive === undefined ? null : Number(snapshot.reasoningLive),
        snapshot.lastUrl ?? null,
        snapshot.lastTitle ?? null,
        snapshot.screenshotPath ?? null,
        snapshot.screenshotDeviceId ?? null,
        JSON.stringify(snapshot.stepDetails ?? [])
      )
  }

  remove(taskId: string): void {
    this.db.prepare('DELETE FROM task_run_history WHERE task_id = ?').run(taskId)
  }
}
