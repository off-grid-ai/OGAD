import {
  MANUAL_BROWSER_HISTORY_LIMIT,
  manualBrowserHistoryEntry,
  manualBrowserHistoryPageSize,
  type ManualBrowserHistoryEntry
} from '@offgrid/automation'
import type { TaskHistoryDatabase } from '../tasks/task-history-store'

interface ManualBrowserHistoryRow {
  history_id: string
  title: string
  url: string
  updated_at: number
}

export { MANUAL_BROWSER_HISTORY_LIMIT } from '@offgrid/automation'

/** Durable recents for user-created browser tabs. These are not task runs. The entry shape, the
 * title fallback, the limit, and the page-size clamp are `@offgrid/automation`'s. */
export class BrowserHistoryStore {
  constructor(
    private readonly db: TaskHistoryDatabase,
    private readonly now: () => number = Date.now
  ) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS manual_browser_history (
        history_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS manual_browser_history_recent
        ON manual_browser_history (updated_at DESC);
    `)
  }

  upsert(input: {
    historyId: string
    title: string
    url: string
    at?: number
  }): ManualBrowserHistoryEntry {
    const entry = manualBrowserHistoryEntry({ ...input, at: input.at ?? this.now() })
    this.db
      .prepare(
        `INSERT INTO manual_browser_history (history_id, title, url, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(history_id) DO UPDATE SET
           title = excluded.title,
           url = excluded.url,
           updated_at = excluded.updated_at`
      )
      .run(entry.historyId, entry.title, entry.url, entry.updatedAt)
    this.trim()
    return entry
  }

  get(historyId: string): ManualBrowserHistoryEntry | undefined {
    const row = this.db
      .prepare('SELECT * FROM manual_browser_history WHERE history_id = ?')
      .get(historyId) as ManualBrowserHistoryRow | undefined
    return row ? this.toEntry(row) : undefined
  }

  list(limit?: number): ManualBrowserHistoryEntry[] {
    return (
      this.db
        .prepare('SELECT * FROM manual_browser_history ORDER BY updated_at DESC LIMIT ?')
        .all(manualBrowserHistoryPageSize(limit)) as ManualBrowserHistoryRow[]
    ).map((row) => this.toEntry(row))
  }

  private toEntry(row: ManualBrowserHistoryRow): ManualBrowserHistoryEntry {
    return {
      historyId: row.history_id,
      kind: 'manual',
      status: 'closed',
      title: row.title,
      url: row.url,
      updatedAt: row.updated_at
    }
  }

  private trim(): void {
    this.db
      .prepare(
        `DELETE FROM manual_browser_history
         WHERE history_id NOT IN (
           SELECT history_id FROM manual_browser_history
           ORDER BY updated_at DESC LIMIT ?
         )`
      )
      .run(MANUAL_BROWSER_HISTORY_LIMIT)
  }
}
