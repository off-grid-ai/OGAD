/**
 * The `rag_messages.uuid` migration, against a REAL legacy database on disk.
 *
 * `rag_messages.id` is INTEGER AUTOINCREMENT and therefore device-local. Cross-device sync keys
 * records by a globally-unique id, so without this column device A's row 7 and device B's row 7
 * would look like the SAME message and silently overwrite each other. This test proves the
 * migration is real: an existing profile gains the column, every pre-existing row is backfilled,
 * the uniqueness constraint exists, and new inserts populate it.
 *
 * Written as a dbtest because it must run the production migration over a database created with the
 * OLD schema — a unit test with a fresh DB would never exercise the upgrade path at all.
 */
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  tmpDir: `/tmp/offgrid-rag-uuid-${process.pid}-${process.env.VITEST_POOL_ID ?? '0'}`
}))

fs.mkdirSync(h.tmpDir, { recursive: true })

vi.mock('electron', () => ({
  app: { getPath: () => h.tmpDir, getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    // Force the plaintext path so the pre-seeded legacy DB is the one that gets opened.
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

const dbPath = path.join(h.tmpDir, 'memories.db')

/** A profile created BEFORE the uuid column existed, with messages already in it. */
const seedLegacyProfile = (): void => {
  const legacy = new Database(dbPath)
  legacy.exec(`
    CREATE TABLE rag_conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE rag_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      context TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
  legacy.prepare('INSERT INTO rag_conversations (id, title) VALUES (?, ?)').run('conv-old', 'Old')
  const insert = legacy.prepare(
    'INSERT INTO rag_messages (conversation_id, role, content) VALUES (?, ?, ?)'
  )
  insert.run('conv-old', 'user', 'first legacy message')
  insert.run('conv-old', 'assistant', 'second legacy message')
  legacy.close()
}

beforeAll(() => {
  fs.rmSync(dbPath, { force: true })
  seedLegacyProfile()
})

afterAll(() => {
  fs.rmSync(h.tmpDir, { recursive: true, force: true })
})

describe('rag_messages.uuid migration', () => {
  it('adds the column and backfills every pre-existing row with a distinct uuid', async () => {
    const { getDB } = await import('../database')
    const db = getDB() // runs the production migration over the legacy profile

    const columns = (db.prepare('PRAGMA table_info(rag_messages)').all() as { name: string }[]).map(
      (c) => c.name
    )
    expect(columns).toContain('uuid')

    const rows = db.prepare('SELECT id, uuid FROM rag_messages ORDER BY id').all() as {
      id: number
      uuid: string | null
    }[]
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      // A null uuid would mean that message can never sync.
      expect(row.uuid, `row ${row.id} was not backfilled`).toBeTruthy()
    }
    expect(new Set(rows.map((r) => r.uuid)).size).toBe(2) // distinct, not one shared value
  })

  it('enforces uniqueness so a replayed remote op upserts instead of duplicating', async () => {
    const { getDB } = await import('../database')
    const db = getDB()
    const existing = (db.prepare('SELECT uuid FROM rag_messages LIMIT 1').get() as { uuid: string })
      .uuid

    expect(() =>
      db
        .prepare('INSERT INTO rag_messages (uuid, conversation_id, role, content) VALUES (?,?,?,?)')
        .run(existing, 'conv-old', 'user', 'duplicate uuid')
    ).toThrow(/UNIQUE/i)
  })

  it('populates uuid on every new message written through the production writer', async () => {
    const { getDB, addRagMessage } = await import('../database')
    const db = getDB()

    const stored = addRagMessage('conv-old', 'user', 'a brand new message')
    const row = db
      .prepare('SELECT uuid, content FROM rag_messages WHERE id = ?')
      .get(stored.id) as {
      uuid: string | null
      content: string
    }
    expect(row.content).toBe('a brand new message')
    expect(row.uuid, 'new messages must carry a uuid or they cannot sync').toBeTruthy()
    // The writer hands the uuid back, so a caller can point at the message it just made.
    expect(stored.uuid).toBe(row.uuid)
  })

  it('is idempotent — running the migration again neither throws nor rewrites uuids', async () => {
    const { getDB } = await import('../database')
    const before = (
      getDB().prepare('SELECT uuid FROM rag_messages ORDER BY id').all() as { uuid: string }[]
    ).map((r) => r.uuid)

    // Close and reopen so the whole migration block runs a second time over the SAME profile.
    getDB().close()
    const after = (
      getDB().prepare('SELECT uuid FROM rag_messages ORDER BY id').all() as { uuid: string }[]
    ).map((r) => r.uuid)

    // Rewriting uuids on every launch would orphan the record on every other device.
    expect(after).toEqual(before)
  })
})
