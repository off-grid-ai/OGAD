/**
 * Durable projection of user-visible task runs. The action engine remains the
 * execution source of truth; this bounded table keeps only the presentation
 * state that disappears when a completed action leaves the durable queue.
 *
 * Browser and computer-use hosts write through this one store. The renderer
 * reads the same rows after a restart, so live tabs and history cannot drift
 * into separate persistence systems.
 */
import {
  automationTaskKindLabel,
  isAutomationTaskTerminal,
  parseAutomationTaskKind,
  parseAutomationTaskReadStatus,
  type AutomationTaskKind,
  type AutomationTaskReadStatus
} from '@offgrid/automation'
import {
  boundComputerUseStepDetails,
  storedComputerUseStepDetails,
  sanitizeComputerUseReasoning,
  type ComputerUsePhase,
  type ComputerUseStepDetail
} from './task-step-details'

export type TaskRunKind = AutomationTaskKind
export type TaskRunStatus = AutomationTaskReadStatus

export interface TaskRunSnapshot {
  taskId: string
  /** Canonical ID shared by Chat, task history, approvals, and synced projections. */
  journeyId: string
  /** Immutable identity of the model selected when this run started. */
  modelId?: string
  modelName?: string
  kind: TaskRunKind
  title: string
  status: TaskRunStatus
  summary?: string
  steps: string[]
  startedAt: number
  finishedAt?: number
  updatedAt: number
  executionDeviceId?: string
  executionDeviceName?: string
  launchId?: string
  requestingDeviceId?: string
  phase?: ComputerUsePhase
  currentStep?: number
  currentAction?: string
  /** Bounded Web Use reasoning. It is separate from the generic task trace. */
  currentReasoning?: string
  reasoningLive?: boolean
  lastUrl?: string
  lastTitle?: string
  /** Device-local path. A synced projection must not treat it as usable. */
  screenshotPath?: string
  screenshotDeviceId?: string
  stepDetails?: ComputerUseStepDetail[]
}

export interface TaskRunUpdate {
  taskId: string
  journeyId?: string
  modelId?: string
  modelName?: string
  kind: TaskRunKind
  title?: string
  status?: TaskRunStatus
  summary?: string
  steps?: string[]
  at?: number
  executionDeviceId?: string
  executionDeviceName?: string
  launchId?: string
  requestingDeviceId?: string
  phase?: ComputerUsePhase
  currentStep?: number
  currentAction?: string
  currentReasoning?: string
  reasoningLive?: boolean
  lastUrl?: string
  lastTitle?: string
  screenshotPath?: string
  screenshotDeviceId?: string
  stepDetails?: ComputerUseStepDetail[]
}

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

export const TASK_HISTORY_LIMIT = 50
export const ORPHANED_LOCAL_WEB_TASK_SUMMARY =
  'Stopped because the earlier local Web Use process is no longer active.'

function safeSteps(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? sanitizeTaskSteps(parsed.filter((step): step is string => typeof step === 'string'))
      : []
  } catch {
    return []
  }
}

const SAFE_LEGACY_GUIDANCE_TRACE = 'GUIDANCE ACCEPTED · Applying to the next decision.'

function sanitizeTaskSteps(steps: readonly string[]): string[] {
  return steps.map((step) =>
    step.startsWith('USER GUIDANCE · ') ? SAFE_LEGACY_GUIDANCE_TRACE : step
  )
}

function rowToSnapshot(row: TaskRunRow): TaskRunSnapshot | undefined {
  const kind = parseAutomationTaskKind(row.kind)
  const status = parseAutomationTaskReadStatus(row.status)
  if (!kind || !status) return undefined
  const terminal = isAutomationTaskTerminal(status)
  const currentReasoning =
    kind === 'web_use' ? sanitizeComputerUseReasoning(row.current_reasoning) : undefined
  return {
    taskId: row.task_id,
    journeyId: row.journey_id || row.task_id,
    ...(row.model_id ? { modelId: row.model_id } : {}),
    ...(row.model_name ? { modelName: row.model_name } : {}),
    kind,
    title: row.title,
    status,
    ...(row.summary ? { summary: row.summary } : {}),
    steps: safeSteps(row.steps_json),
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
    ...(currentReasoning ? { currentReasoning } : {}),
    ...(kind === 'web_use' && (row.reasoning_live === 0 || row.reasoning_live === 1)
      ? { reasoningLive: !terminal && row.reasoning_live === 1 }
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

function persistedModelIdentity(
  previous: TaskRunSnapshot | undefined,
  update: TaskRunUpdate
): Pick<TaskRunSnapshot, 'modelId' | 'modelName'> {
  if (previous?.modelId) {
    return {
      modelId: previous.modelId,
      modelName: previous.modelName || previous.modelId
    }
  }
  const modelId = update.modelId?.trim()
  if (!modelId) return {}
  return { modelId, modelName: update.modelName?.trim() || modelId }
}

function persistedReasoning(
  previous: TaskRunSnapshot | undefined,
  update: TaskRunUpdate,
  kind: TaskRunKind,
  status: TaskRunStatus
): Pick<TaskRunSnapshot, 'currentReasoning' | 'reasoningLive'> {
  if (kind !== 'web_use') return {}
  const currentReasoning =
    update.currentReasoning !== undefined
      ? sanitizeComputerUseReasoning(update.currentReasoning)
      : previous?.currentReasoning
  const hasReasoningState =
    update.currentReasoning !== undefined ||
    update.reasoningLive !== undefined ||
    previous?.currentReasoning !== undefined ||
    previous?.reasoningLive !== undefined
  const terminal = isAutomationTaskTerminal(status)
  const reasoningLive = terminal
    ? hasReasoningState
      ? false
      : undefined
    : (update.reasoningLive ?? previous?.reasoningLive)
  return {
    ...(currentReasoning ? { currentReasoning } : {}),
    ...(reasoningLive !== undefined ? { reasoningLive } : {})
  }
}

export class TaskHistoryStore {
  constructor(
    private readonly db: TaskHistoryDatabase,
    private readonly now: () => number = Date.now
  ) {}

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
    try {
      this.db.exec('ALTER TABLE task_run_history ADD COLUMN journey_id TEXT')
    } catch {
      // Existing databases may already have the column.
    }
    for (const column of [
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
      'screenshot_device_id TEXT'
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
    try {
      this.db.exec(
        "ALTER TABLE task_run_history ADD COLUMN step_details_json TEXT NOT NULL DEFAULT '[]'"
      )
    } catch {
      // Existing databases may already have the column.
    }
    // Early guidance builds stored the exact user text. Remove it from existing
    // local rows so it cannot enter task history or cross-device sync.
    try {
      const rows = this.db
        .prepare('SELECT task_id, steps_json FROM task_run_history')
        .all() as Array<{ task_id: string; steps_json: string }>
      const update = this.db.prepare('UPDATE task_run_history SET steps_json = ? WHERE task_id = ?')
      for (const row of rows) {
        const sanitized = safeSteps(row.steps_json)
        const next = JSON.stringify(sanitized)
        if (next !== row.steps_json) update.run(next, row.task_id)
      }
    } catch {
      // Keep migration compatible with partial test databases.
    }
    // Normalize legacy Computer Use details through the current persistence boundary. Earlier
    // builds stored model sentinel strings such as "null", which then appeared as real decisions.
    try {
      const rows = this.db
        .prepare('SELECT task_id, step_details_json FROM task_run_history')
        .all() as Array<{ task_id: string; step_details_json: string }>
      const update = this.db.prepare(
        'UPDATE task_run_history SET step_details_json = ? WHERE task_id = ?'
      )
      for (const row of rows) {
        const next = JSON.stringify(
          boundComputerUseStepDetails(storedComputerUseStepDetails(row.step_details_json))
        )
        if (next !== row.step_details_json) update.run(next, row.task_id)
      }
    } catch {
      // Keep migration compatible with partial test databases.
    }
  }

  upsert(update: TaskRunUpdate): TaskRunSnapshot {
    const at = update.at ?? this.now()
    const previous = this.get(update.taskId)
    const kind = parseAutomationTaskKind(update.kind)
    const status = parseAutomationTaskReadStatus(update.status ?? previous?.status ?? 'running')
    if (!kind || !status) throw new Error('Task history received an invalid task kind or status.')
    const finishedAt = isAutomationTaskTerminal(status) ? (previous?.finishedAt ?? at) : undefined
    const snapshot: TaskRunSnapshot = {
      taskId: update.taskId,
      journeyId: update.journeyId?.trim() || previous?.journeyId || update.taskId,
      ...persistedModelIdentity(previous, update),
      ...persistedReasoning(previous, update, kind, status),
      kind,
      title: update.title?.trim() || previous?.title || automationTaskKindLabel(kind),
      status,
      ...(update.summary !== undefined
        ? { summary: update.summary }
        : previous?.summary
          ? { summary: previous.summary }
          : {}),
      steps: sanitizeTaskSteps(update.steps ?? previous?.steps ?? []),
      startedAt: previous?.startedAt ?? at,
      ...(finishedAt ? { finishedAt } : {}),
      updatedAt: at,
      ...(update.executionDeviceId !== undefined
        ? { executionDeviceId: update.executionDeviceId }
        : previous?.executionDeviceId
          ? { executionDeviceId: previous.executionDeviceId }
          : {}),
      ...(update.executionDeviceName !== undefined
        ? { executionDeviceName: update.executionDeviceName }
        : previous?.executionDeviceName
          ? { executionDeviceName: previous.executionDeviceName }
          : {}),
      ...(update.launchId !== undefined
        ? { launchId: update.launchId }
        : previous?.launchId
          ? { launchId: previous.launchId }
          : {}),
      ...(update.requestingDeviceId !== undefined
        ? { requestingDeviceId: update.requestingDeviceId }
        : previous?.requestingDeviceId
          ? { requestingDeviceId: previous.requestingDeviceId }
          : {}),
      ...(update.phase !== undefined
        ? { phase: update.phase }
        : previous?.phase
          ? { phase: previous.phase }
          : {}),
      ...(update.currentStep !== undefined
        ? { currentStep: update.currentStep }
        : previous?.currentStep !== undefined
          ? { currentStep: previous.currentStep }
          : {}),
      ...(update.currentAction !== undefined
        ? { currentAction: update.currentAction }
        : previous?.currentAction
          ? { currentAction: previous.currentAction }
          : {}),
      ...(update.lastUrl !== undefined
        ? { lastUrl: update.lastUrl }
        : previous?.lastUrl
          ? { lastUrl: previous.lastUrl }
          : {}),
      ...(update.lastTitle !== undefined
        ? { lastTitle: update.lastTitle }
        : previous?.lastTitle
          ? { lastTitle: previous.lastTitle }
          : {}),
      ...(update.screenshotPath !== undefined
        ? { screenshotPath: update.screenshotPath }
        : previous?.screenshotPath
          ? { screenshotPath: previous.screenshotPath }
          : {}),
      ...(update.screenshotDeviceId !== undefined
        ? { screenshotDeviceId: update.screenshotDeviceId }
        : previous?.screenshotDeviceId
          ? { screenshotDeviceId: previous.screenshotDeviceId }
          : {}),
      ...(update.stepDetails !== undefined
        ? { stepDetails: boundComputerUseStepDetails(update.stepDetails) }
        : previous?.stepDetails
          ? { stepDetails: previous.stepDetails }
          : {})
    }

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
    this.trim()
    return snapshot
  }

  appendStep(taskId: string, kind: TaskRunKind, title: string, step: string): TaskRunSnapshot {
    const previous = this.get(taskId)
    return this.upsert({
      taskId,
      kind,
      title,
      steps: [...(previous?.steps ?? []), step]
    })
  }

  get(taskId: string): TaskRunSnapshot | undefined {
    const row = this.db.prepare('SELECT * FROM task_run_history WHERE task_id = ?').get(taskId) as
      | TaskRunRow
      | undefined
    return row ? rowToSnapshot(row) : undefined
  }

  list(limit = TASK_HISTORY_LIMIT): TaskRunSnapshot[] {
    const safeLimit = Math.max(1, Math.min(TASK_HISTORY_LIMIT, Math.floor(limit)))
    return (
      this.db
        .prepare('SELECT * FROM task_run_history ORDER BY updated_at DESC, task_id DESC LIMIT ?')
        .all(safeLimit) as TaskRunRow[]
    ).flatMap((row) => {
      const snapshot = rowToSnapshot(row)
      return snapshot ? [snapshot] : []
    })
  }

  /** Add one remote visual audit step without changing the execution owner's task timestamps. */
  materializeVisualStep(
    taskId: string,
    detail: ComputerUseStepDetail
  ): TaskRunSnapshot | undefined {
    const current = this.get(taskId)
    if (!current) return undefined
    const stepDetails = boundComputerUseStepDetails([
      ...(current.stepDetails ?? []).filter((candidate) => candidate.stepId !== detail.stepId),
      detail
    ]).sort((left, right) => left.at - right.at || left.stepId.localeCompare(right.stepId))
    this.db
      .prepare('UPDATE task_run_history SET step_details_json = ? WHERE task_id = ?')
      .run(JSON.stringify(stepDetails), taskId)
    return this.get(taskId)
  }

  /** Remove one remote visual step after the execution owner publishes its tombstone. */
  removeVisualStep(taskId: string, stepId: string): TaskRunSnapshot | undefined {
    const current = this.get(taskId)
    if (!current) return undefined
    const stepDetails = (current.stepDetails ?? []).filter(
      (candidate) => candidate.stepId !== stepId
    )
    this.db
      .prepare('UPDATE task_run_history SET step_details_json = ? WHERE task_id = ?')
      .run(JSON.stringify(stepDetails), taskId)
    return this.get(taskId)
  }

  /** Reconcile one task after a renderer or main-process restart lost its live
   * owner. A remote task and a native Computer Use task belong to other owners
   * and must not be changed by the browser host. */
  stopOrphanedLocalWebTask(
    taskId: string,
    executionDeviceId: string,
    at = this.now()
  ): TaskRunSnapshot | undefined {
    const task = this.get(taskId)
    if (
      !task ||
      task.kind !== 'web_use' ||
      isAutomationTaskTerminal(task.status) ||
      (task.executionDeviceId && task.executionDeviceId !== executionDeviceId)
    ) {
      return undefined
    }
    return this.upsert({
      taskId,
      kind: 'web_use',
      status: 'stopped',
      summary: ORPHANED_LOCAL_WEB_TASK_SUMMARY,
      phase: 'stopped',
      currentAction: 'Stopped after the local Web Use process ended',
      at
    })
  }

  /** A live task cannot survive an Electron process restart. Close only those
   * interrupted rows, while preserving their last page/screenshot and log. */
  recoverInterrupted(executionDeviceId: string, at = this.now()): number {
    return this.db
      .prepare(
        `UPDATE task_run_history
         SET status = 'stopped',
             summary = COALESCE(summary, 'Off Grid AI closed before this task finished.'),
             finished_at = COALESCE(finished_at, ?),
             updated_at = ?,
             reasoning_live = CASE
               WHEN current_reasoning IS NOT NULL OR reasoning_live IS NOT NULL THEN 0
               ELSE reasoning_live
             END
         WHERE status IN ('running', 'paused', 'waiting', 'reconnecting')
           AND (execution_device_id = ? OR execution_device_id IS NULL)`
      )
      .run(at, at, executionDeviceId).changes
  }

  private trim(): void {
    this.db
      .prepare(
        `DELETE FROM task_run_history
         WHERE task_id NOT IN (
           SELECT task_id FROM task_run_history ORDER BY updated_at DESC, task_id DESC LIMIT ?
         )`
      )
      .run(TASK_HISTORY_LIMIT)
  }
}
