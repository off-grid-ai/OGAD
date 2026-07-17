import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, describe, expect, it } from 'vitest'
import { ImportJournalStore, type JournalAction } from '../sync-portable/import-journal'

const roots: string[] = []

function fixture(): {
  root: string
  db: Database.Database
  store: ImportJournalStore
  action: JournalAction
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-journal-'))
  roots.push(root)
  const stage = path.join(root, 'sync-portable', 'stages', 'stage-test')
  const restore = path.join(root, 'sync-files')
  fs.mkdirSync(stage, { recursive: true })
  fs.mkdirSync(restore, { recursive: true })
  const destination = path.join(restore, 'knowledge.txt')
  const stagedPath = path.join(stage, 'knowledge.txt')
  fs.writeFileSync(destination, 'old content')
  fs.writeFileSync(stagedPath, 'new content')
  const db = new Database(':memory:')
  const store = new ImportJournalStore(root, db)
  store.ensureSchema()
  return {
    root,
    db,
    store,
    action: {
      key: 'knowledge',
      path: destination,
      stagedPath,
      backupPath: `${destination}.offgrid-rollback-${randomUUID()}`,
      kind: 'replace',
      status: 'planned'
    }
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('durable portable import journal recovery', () => {
  it('rolls back an import that terminated before the first file mutation', () => {
    const { db, store, action } = fixture()
    store.create(randomUUID(), [action])

    store.recover()
    store.recover()

    expect(fs.readFileSync(action.path, 'utf8')).toBe('old content')
    expect(fs.existsSync(action.stagedPath)).toBe(false)
    db.close()
  })

  it('restores a replacement terminated immediately after moving the backup', () => {
    const { db, store, action } = fixture()
    store.create(randomUUID(), [action])
    fs.renameSync(action.path, action.backupPath!)

    store.recover()
    store.recover()

    expect(fs.readFileSync(action.path, 'utf8')).toBe('old content')
    expect(fs.existsSync(action.backupPath!)).toBe(false)
    db.close()
  })

  it('rolls back installed files when SQLite did not commit', () => {
    const { db, store, action } = fixture()
    const journal = store.create(randomUUID(), [action])!
    fs.renameSync(action.path, action.backupPath!)
    journal.update(0, 'backed-up')
    fs.renameSync(action.stagedPath, action.path)
    journal.update(0, 'installed')

    store.recover()
    store.recover()

    expect(fs.readFileSync(action.path, 'utf8')).toBe('old content')
    expect(fs.existsSync(action.backupPath!)).toBe(false)
    db.close()
  })

  it('finishes cleanup when the database commit marker is durable', () => {
    const { db, store, action } = fixture()
    const journal = store.create(randomUUID(), [action])!
    fs.renameSync(action.path, action.backupPath!)
    journal.update(0, 'backed-up')
    fs.renameSync(action.stagedPath, action.path)
    journal.update(0, 'installed')
    db.transaction(() => store.markCommitted(journal.id))()

    store.recover()
    store.recover()

    expect(fs.readFileSync(action.path, 'utf8')).toBe('new content')
    expect(fs.existsSync(action.backupPath!)).toBe(false)
    expect(
      db.prepare('SELECT id FROM portable_import_commits WHERE id = ?').get(journal.id)
    ).toBeUndefined()
    db.close()
  })

  it('removes an uncommitted newly-created file and keeps a committed one', () => {
    const uncommitted = fixture()
    fs.rmSync(uncommitted.action.path)
    const createAction: JournalAction = {
      ...uncommitted.action,
      kind: 'create',
      backupPath: undefined
    }
    uncommitted.store.create(randomUUID(), [createAction])
    fs.renameSync(createAction.stagedPath, createAction.path)
    uncommitted.store.recover()
    uncommitted.store.recover()
    expect(fs.existsSync(createAction.path)).toBe(false)
    uncommitted.db.close()

    const committed = fixture()
    fs.rmSync(committed.action.path)
    const committedAction: JournalAction = {
      ...committed.action,
      kind: 'create',
      backupPath: undefined
    }
    const journal = committed.store.create(randomUUID(), [committedAction])!
    fs.renameSync(committedAction.stagedPath, committedAction.path)
    journal.update(0, 'installed')
    committed.db.transaction(() => committed.store.markCommitted(journal.id))()
    committed.store.recover()
    committed.store.recover()
    expect(fs.readFileSync(committedAction.path, 'utf8')).toBe('new content')
    committed.db.close()
  })

  it('fails closed and leaves state untouched for a corrupt journal', () => {
    const { root, db, store, action } = fixture()
    const journalRoot = path.join(root, 'sync-portable', 'journals')
    fs.mkdirSync(journalRoot, { recursive: true })
    const corrupt = path.join(journalRoot, `${randomUUID()}.json`)
    fs.writeFileSync(corrupt, '{not json')

    expect(() => store.recover()).toThrow('corrupt')
    expect(fs.readFileSync(action.path, 'utf8')).toBe('old content')
    expect(fs.existsSync(corrupt)).toBe(true)
    db.close()
  })
})
