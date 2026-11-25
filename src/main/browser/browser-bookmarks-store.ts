import { randomUUID } from 'node:crypto'
import type { TaskHistoryDatabase } from '../tasks/task-history-store'
import type { BrowserBookmark } from '../../shared/browser-library'

interface BookmarkRow {
  bookmark_id: string
  url: string
  title: string
  created_at: number
}

/** The person's bookmarks in the built-in browser. One bookmark per address. */
export class BrowserBookmarksStore {
  constructor(
    private readonly db: TaskHistoryDatabase,
    private readonly now: () => number = Date.now
  ) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS browser_bookmarks (
        bookmark_id TEXT PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
  }

  list(): BrowserBookmark[] {
    return (
      this.db
        .prepare('SELECT * FROM browser_bookmarks ORDER BY created_at DESC')
        .all() as BookmarkRow[]
    ).map(toBookmark)
  }

  has(url: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM browser_bookmarks WHERE url = ?').get(url))
  }

  /** Bookmark the page, or remove its bookmark. Returns whether it is now bookmarked. */
  toggle(input: { url: string; title: string }): boolean {
    if (!/^https?:\/\//i.test(input.url)) return false
    if (this.has(input.url)) {
      this.db.prepare('DELETE FROM browser_bookmarks WHERE url = ?').run(input.url)
      return false
    }
    this.db
      .prepare(
        'INSERT INTO browser_bookmarks (bookmark_id, url, title, created_at) VALUES (?, ?, ?, ?)'
      )
      .run(randomUUID(), input.url, input.title.trim() || input.url, this.now())
    return true
  }

  rename(bookmarkId: string, title: string): void {
    const value = title.trim()
    if (!value) return
    this.db
      .prepare('UPDATE browser_bookmarks SET title = ? WHERE bookmark_id = ?')
      .run(value, bookmarkId)
  }

  remove(bookmarkId: string): void {
    this.db.prepare('DELETE FROM browser_bookmarks WHERE bookmark_id = ?').run(bookmarkId)
  }
}

function toBookmark(row: BookmarkRow): BrowserBookmark {
  return { bookmarkId: row.bookmark_id, url: row.url, title: row.title, createdAt: row.created_at }
}
