import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserVisitsStore } from '../browser/browser-visits-store'
import { BrowserBookmarksStore } from '../browser/browser-bookmarks-store'
import { BrowserOpenTabsStore } from '../browser/browser-open-tabs-store'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

function databaseFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-browser-library-'))
  directories.push(directory)
  return path.join(directory, 'library.db')
}

describe('browser history', () => {
  it('finds visits by any words in the title or address, newest first, after a restart', () => {
    const file = databaseFile()
    let now = 1_000
    const db = new Database(file)
    const visits = new BrowserVisitsStore(db, () => now)
    visits.migrate()
    const docs = visits.record({ url: 'https://example.com/docs', title: '' })
    now = 2_000
    visits.record({ url: 'https://news.example.org/today', title: 'Morning news' })
    now = 3_000
    visits.record({ url: 'https://shop.test/cart', title: 'Cart', taskId: 'task-1' })
    // The title arrives after the address.
    visits.retitle(docs!, 'Example documentation')
    db.close()

    const reopened = new BrowserVisitsStore(new Database(file), () => now)
    reopened.migrate()
    expect(reopened.search().map((visit) => visit.url)).toEqual([
      'https://shop.test/cart',
      'https://news.example.org/today',
      'https://example.com/docs'
    ])
    expect(reopened.search('documentation example').map((visit) => visit.title)).toEqual([
      'Example documentation'
    ])
    expect(reopened.search('news.example')).toHaveLength(1)
    // LIKE wildcards in a query are literal text.
    expect(reopened.search('%')).toEqual([])
    expect(reopened.search('', 2_500).map((visit) => visit.visitedAt)).toEqual([2_000, 1_000])
  })

  it('keeps a task trail the agent can read, and clears by time', () => {
    let now = 10_000
    const visits = new BrowserVisitsStore(new Database(databaseFile()), () => now)
    visits.migrate()
    for (const url of ['https://a.test/', 'https://b.test/', 'https://a.test/']) {
      now += 1_000
      visits.record({ url, title: url, taskId: 'task-9' })
    }
    visits.record({ url: 'https://person.test/', title: 'Mine' })
    expect(visits.taskTrail('task-9').map((visit) => visit.url)).toEqual([
      'https://a.test/',
      'https://b.test/',
      'https://a.test/'
    ])
    // Clearing "since 12.5s" drops the last visit and the person's own; newest first after that.
    visits.clear(12_500)
    expect(visits.search().map((visit) => visit.url)).toEqual([
      'https://b.test/',
      'https://a.test/'
    ])
    visits.clear()
    expect(visits.search()).toEqual([])
  })

  it('never records a page that is not on the web', () => {
    const visits = new BrowserVisitsStore(new Database(databaseFile()))
    visits.migrate()
    expect(visits.record({ url: 'about:blank', title: '' })).toBeNull()
    expect(visits.record({ url: 'file:///etc/passwd', title: '' })).toBeNull()
    expect(visits.search()).toEqual([])
  })

  it('drops visits older than 90 days when it opens', () => {
    const file = databaseFile()
    const day = 86_400_000
    const first = new BrowserVisitsStore(new Database(file), () => 0)
    first.migrate()
    first.record({ url: 'https://old.test/', title: 'Old' })
    const later = new BrowserVisitsStore(new Database(file), () => 91 * day)
    later.migrate()
    expect(later.search()).toEqual([])
  })
})

describe('bookmarks', () => {
  it('stars and unstars a page, one bookmark per address, kept across a restart', () => {
    const file = databaseFile()
    const bookmarks = new BrowserBookmarksStore(new Database(file), () => 5)
    bookmarks.migrate()
    expect(bookmarks.toggle({ url: 'https://example.com/', title: 'Example' })).toBe(true)
    expect(bookmarks.toggle({ url: 'about:blank', title: '' })).toBe(false)
    const reopened = new BrowserBookmarksStore(new Database(file))
    reopened.migrate()
    expect(reopened.has('https://example.com/')).toBe(true)
    const [saved] = reopened.list()
    reopened.rename(saved!.bookmarkId, 'Renamed')
    expect(reopened.list()[0]!.title).toBe('Renamed')
    expect(reopened.toggle({ url: 'https://example.com/', title: 'Example' })).toBe(false)
    expect(reopened.list()).toEqual([])
  })
})

describe('open tabs', () => {
  it('brings back the open tabs in order with the active one marked', () => {
    const file = databaseFile()
    const tabs = new BrowserOpenTabsStore(new Database(file))
    tabs.migrate()
    tabs.save([
      { historyId: 'one', active: false },
      { historyId: 'two', active: true }
    ])
    const reopened = new BrowserOpenTabsStore(new Database(file))
    reopened.migrate()
    expect(reopened.list()).toEqual([
      { historyId: 'one', active: false },
      { historyId: 'two', active: true }
    ])
    reopened.save([])
    expect(reopened.list()).toEqual([])
  })
})
