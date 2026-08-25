/**
 * Durable projection of user-visible task runs. The action engine remains the
 * execution source of truth; this bounded table keeps only the presentation
 * state that disappears when a completed action leaves the durable queue.
 *
 * Browser and computer-use hosts write through this one store. The renderer
 * reads the same rows after a restart, so live tabs and history cannot drift
 * into separate persistence systems.
 */
export type TaskRunKind = 'web_use' | 'computer_use'
export type LegacyTaskRunKind = TaskRunKind | 'web_task' | 'computer_task'
export type TaskRunStatus = 'running' | 'paused' | 'done' | 'failed' | 'stopped'

export interface TaskRunSnapshot {
  taskId: string
  kind: TaskRunKind
  title: string
  status: TaskRunStatus
  summary?: string
  steps: string[]
  startedAt: number
  finishedAt?: number
  updatedAt: number
  lastUrl?: string
  lastTitle?: string
  screenshotPath?: string
}

export interface TaskRunUpdate {
  taskId: string
  kind: LegacyTaskRunKind
  title?: string
  status?: TaskRunStatus
  summary?: string
  steps?: string[]
  at?: number
  lastUrl?: string
  lastTitle?: string
  screenshotPath?: string
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
  kind: string
  title: string
  status: string
  summary: string | null
  steps_json: string
  started_at: number
  finished_at: number | null
  updated_at: number
  last_url: string | null
  last_title: string | null
  screenshot_path: string | null
}

export const TASK_HISTORY_LIMIT = 50

export function canonicalTaskKind(kind: LegacyTaskRunKind): TaskRunKind {
  return kind === 'web_task' || kind === 'web_use' ? 'web_use' : 'computer_use'
}

function safeSteps(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((step): step is string => typeof step === 'string')
      : []
  } catch {
    return []
  }
}

function rowToSnapshot(row: TaskRunRow): TaskRunSnapshot {
  return {
    taskId: row.task_id,
    kind: canonicalTaskKind(row.kind as LegacyTaskRunKind),
    title: row.title,
    status: row.status as TaskRunStatus,
    ...(row.summary ? { summary: row.summary } : {}),
    steps: safeSteps(row.steps_json),
    startedAt: row.started_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    updatedAt: row.updated_at,
    ...(row.last_url ? { lastUrl: row.last_url } : {}),
    ...(row.last_title ? { lastTitle: row.last_title } : {}),
    ...(row.screenshot_path ? { screenshotPath: row.screenshot_path } : {})
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
      );
      CREATE INDEX IF NOT EXISTS task_run_history_recent
        ON task_run_history (updated_at DESC);
    `)
  }

  upsert(update: TaskRunUpdate): TaskRunSnapshot {
    const at = update.at ?? this.now()
    const previous = this.get(update.taskId)
    const kind = canonicalTaskKind(update.kind)
    const status = update.status ?? previous?.status ?? 'running'
    const finishedAt =
      status === 'done' || status === 'failed' || status === 'stopped'
        ? (previous?.finishedAt ?? at)
        : undefined
    const snapshot: TaskRunSnapshot = {
      taskId: update.taskId,
      kind,
      title:
        update.title?.trim() ||
        previous?.title ||
        (kind === 'web_use' ? 'Web Use' : 'Computer Use'),
      status,
      ...(update.summary !== undefined
        ? { summary: update.summary }
        : previous?.summary
          ? { summary: previous.summary }
          : {}),
      steps: update.steps ?? previous?.steps ?? [],
      startedAt: previous?.startedAt ?? at,
      ...(finishedAt ? { finishedAt } : {}),
      updatedAt: at,
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
          : {})
    }

    this.db
      .prepare(
        `INSERT INTO task_run_history (
           task_id, kind, title, status, summary, steps_json, started_at,
           finished_at, updated_at, last_url, last_title, screenshot_path
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           kind = excluded.kind,
           title = excluded.title,
           status = excluded.status,
           summary = excluded.summary,
           steps_json = excluded.steps_json,
           finished_at = excluded.finished_at,
           updated_at = excluded.updated_at,
           last_url = excluded.last_url,
           last_title = excluded.last_title,
           screenshot_path = excluded.screenshot_path`
      )
      .run(
        snapshot.taskId,
        snapshot.kind,
        snapshot.title,
        snapshot.status,
        snapshot.summary ?? null,
        JSON.stringify(snapshot.steps),
        snapshot.startedAt,
        snapshot.finishedAt ?? null,
        snapshot.updatedAt,
        snapshot.lastUrl ?? null,
        snapshot.lastTitle ?? null,
        snapshot.screenshotPath ?? null
      )
    this.trim()
    return snapshot
  }

  appendStep(
    taskId: string,
    kind: LegacyTaskRunKind,
    title: string,
    step: string
  ): TaskRunSnapshot {
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
    ).map(rowToSnapshot)
  }

  /** A live task cannot survive an Electron process restart. Close only those
   * interrupted rows, while preserving their last page/screenshot and log. */
  recoverInterrupted(at = this.now()): number {
    return this.db
      .prepare(
        `UPDATE task_run_history
         SET status = 'stopped',
             summary = COALESCE(summary, 'Off Grid AI closed before this task finished.'),
             finished_at = COALESCE(finished_at, ?),
             updated_at = ?
         WHERE status IN ('running', 'paused')`
      )
      .run(at, at).changes
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
