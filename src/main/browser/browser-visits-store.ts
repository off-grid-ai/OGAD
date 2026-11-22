import type { TaskHistoryDatabase } from '../tasks/task-history-store'
import {
  BROWSER_HISTORY_DAYS,
  BROWSER_HISTORY_PAGE,
  type BrowserVisit
} from '../../shared/browser-library'

interface VisitRow {
  visit_id: number
  url: string
  title: string
  visited_at: number
  task_id: string | null
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Every page the built-in browser showed, the person's and the agent's: the searchable history.
 * Task visits carry their task id, so the harness can tell the agent where it has already been.
 */
export class BrowserVisitsStore {
  constructor(
    private readonly db: TaskHistoryDatabase,
    private readonly now: () => number = Date.now
  ) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS browser_visits (
        visit_id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        visited_at INTEGER NOT NULL,
        task_id TEXT
      );
      CREATE INDEX IF NOT EXISTS browser_visits_recent ON browser_visits (visited_at DESC);
      CREATE INDEX IF NOT EXISTS browser_visits_task ON browser_visits (task_id, visited_at);
    `)
    this.db
      .prepare('DELETE FROM browser_visits WHERE visited_at < ?')
      .run(this.now() - BROWSER_HISTORY_DAYS * DAY_MS)
  }

  /** Record one visit. The host calls it when a page's address changes, not on every repaint. */
  record(input: { url: string; title: string; taskId?: string }): number | null {
    if (!/^https?:\/\//i.test(input.url)) return null
    const result = this.db
      .prepare('INSERT INTO browser_visits (url, title, visited_at, task_id) VALUES (?, ?, ?, ?)')
      .run(input.url, input.title.trim() || input.url, this.now(), input.taskId ?? null) as {
      lastInsertRowid?: number | bigint
    }
    return result.lastInsertRowid === undefined ? null : Number(result.lastInsertRowid)
  }

  /** The page's title arrives after its address. */
  retitle(visitId: number, title: string): void {
    const value = title.trim()
    if (!value) return
    this.db.prepare('UPDATE browser_visits SET title = ? WHERE visit_id = ?').run(value, visitId)
  }

  /** Newest first. A query matches words in the title or the address, in any order. */
  search(query = '', before?: number, limit = BROWSER_HISTORY_PAGE): BrowserVisit[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)
    const where = ['visited_at < ?', ...words.map(() => "lower(title || ' ' || url) LIKE ?")]
    const args: unknown[] = [
      before ?? Number.MAX_SAFE_INTEGER,
      ...words.map((word) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    ]
    const sql = `SELECT * FROM browser_visits WHERE ${where
      .map((clause, i) => (i === 0 ? clause : `${clause} ESCAPE '\\'`))
      .join(' AND ')} ORDER BY visited_at DESC, visit_id DESC LIMIT ?`
    const safeLimit = Math.max(1, Math.min(BROWSER_HISTORY_PAGE, Math.floor(limit)))
    return (this.db.prepare(sql).all(...args, safeLimit) as VisitRow[]).map(toVisit)
  }

  /** The pages one task opened, oldest first: the agent's own trail. */
  taskTrail(taskId: string): BrowserVisit[] {
    return (
      this.db
        .prepare('SELECT * FROM browser_visits WHERE task_id = ? ORDER BY visited_at, visit_id')
        .all(taskId) as VisitRow[]
    ).map(toVisit)
  }

  remove(visitId: number): void {
    this.db.prepare('DELETE FROM browser_visits WHERE visit_id = ?').run(visitId)
  }

  /** Clear everything, or only visits since a time (the "last hour" choice). */
  clear(since?: number): void {
    this.db.prepare('DELETE FROM browser_visits WHERE visited_at >= ?').run(since ?? 0)
  }
}

function toVisit(row: VisitRow): BrowserVisit {
  return {
    visitId: row.visit_id,
    url: row.url,
    title: row.title,
    visitedAt: row.visited_at,
    ...(row.task_id ? { taskId: row.task_id } : {})
  }
}
