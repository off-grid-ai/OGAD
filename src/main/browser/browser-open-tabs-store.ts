import type { TaskHistoryDatabase } from '../tasks/task-history-store'

interface OpenTabRow {
  history_id: string
  position: number
  active: number
}

export interface OpenTab {
  historyId: string
  active: boolean
}

/**
 * The person's tabs that were open when the app last ran, in order, so the next launch brings
 * them back where they were. The page itself (address, title) lives in manual_browser_history.
 */
export class BrowserOpenTabsStore {
  constructor(private readonly db: TaskHistoryDatabase) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS browser_open_tabs (
        history_id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 0
      );
    `)
  }

  list(): OpenTab[] {
    return (
      this.db.prepare('SELECT * FROM browser_open_tabs ORDER BY position').all() as OpenTabRow[]
    ).map((row) => ({ historyId: row.history_id, active: row.active === 1 }))
  }

  /** Replace the saved set with the tabs open now. */
  save(tabs: readonly OpenTab[]): void {
    this.db.exec('DELETE FROM browser_open_tabs')
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO browser_open_tabs (history_id, position, active) VALUES (?, ?, ?)'
    )
    tabs.forEach((tab, position) => insert.run(tab.historyId, position, tab.active ? 1 : 0))
  }
}
