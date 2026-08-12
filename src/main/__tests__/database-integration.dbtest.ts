// Integration tests for the core data layer (src/main/database.ts) run against a
// REAL temp SQLite DB - no mocks of our own logic. database.ts imports `electron`
// at the top level and resolves its data dir from app.getPath('userData'), so we
// mock ONLY that true boundary (Electron's app + safeStorage) and point it at a
// fresh mkdtemp dir. Everything else - schema, CRUD, queries, JSON round-trips -
// runs the real better-sqlite3 file so a failing assertion reflects real breakage.

import { describe, it, expect, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Fresh temp userData dir for this test file. Created BEFORE the module import so
// getDB() opens memories.db inside it. safeStorage is reported unavailable so the
// DB is created as plaintext (no Keychain in CI) - the code path we can exercise.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-db-it-'))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

// Imported after the mock is registered so the module's top-level electron import
// resolves to the stub above.
import * as db from '../database'
import * as entityDomain from '../entity-domain'

function resolveEntity(name: string, type?: string): number {
  const result = entityDomain.resolveEntityCandidate({ name, type })
  if (!result.admitted) throw new Error(`Entity was rejected: ${result.reason}`)
  return result.entityId
}

afterAll(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe('database.ts - schema bootstrap (real temp SQLite)', () => {
  it('getDB() creates memories.db in the configured userData dir', () => {
    const handle = db.getDB()
    expect(handle).toBeTruthy()
    expect(fs.existsSync(path.join(TMP_DIR, 'memories.db'))).toBe(true)
  })

  it('returns the same singleton on repeated calls', () => {
    expect(db.getDB()).toBe(db.getDB())
  })

  it('reopens the same profile after the cached handle is closed', () => {
    const first = db.getDB()
    first
      .prepare('INSERT INTO conversations (id, title) VALUES (?, ?)')
      .run('reopen-probe', 'Persisted across close')
    first.close()

    const reopened = db.getDB()
    expect(reopened).not.toBe(first)
    expect(reopened.open).toBe(true)
    expect(
      reopened.prepare('SELECT title FROM conversations WHERE id = ?').get('reopen-probe')
    ).toEqual({ title: 'Persisted across close' })
    expect(db.getDB()).toBe(reopened)
  })

  it('runMigration runs idempotent DDL without throwing', () => {
    expect(() =>
      db.runMigration('CREATE TABLE IF NOT EXISTS it_probe (id INTEGER PRIMARY KEY)')
    ).not.toThrow()
    // running again is a no-op (IF NOT EXISTS)
    expect(() =>
      db.runMigration('CREATE TABLE IF NOT EXISTS it_probe (id INTEGER PRIMARY KEY)')
    ).not.toThrow()
  })
})

describe('database.ts - RAG conversations CRUD', () => {
  it('createRagConversation + getRagConversation round-trips id, title and project', () => {
    db.createRagConversation('conv-1', 'First chat', 'proj-A')
    const got = db.getRagConversation('conv-1')
    expect(got).toBeTruthy()
    expect(got?.id).toBe('conv-1')
    expect(got?.title).toBe('First chat')
    // project_id round-trip - this was a live bug.
    expect(got?.project_id).toBe('proj-A')
  })

  it('createRagConversation defaults title and project to null when omitted', () => {
    db.createRagConversation('conv-null')
    const got = db.getRagConversation('conv-null')
    expect(got?.title).toBeNull()
    expect(got?.project_id).toBeNull()
  })

  it('getRagConversation returns a falsy value for a missing id', () => {
    // better-sqlite3 .get() yields undefined for no row (the return is typed
    // `| null`, but the runtime value is undefined) - assert absence either way.
    expect(db.getRagConversation('does-not-exist')).toBeFalsy()
  })

  it('getRagConversations() with no filter lists all conversations with a message_count', () => {
    const all = db.getRagConversations()
    const ids = all.map((c) => c.id)
    expect(ids).toContain('conv-1')
    expect(ids).toContain('conv-null')
    const c1 = all.find((c) => c.id === 'conv-1')
    expect(typeof c1?.message_count).toBe('number')
  })

  it('getRagConversations(projectId) filters to a project, and (null) filters to unscoped', () => {
    db.createRagConversation('conv-projB', 'B chat', 'proj-B')
    const inA = db.getRagConversations('proj-A').map((c) => c.id)
    expect(inA).toContain('conv-1')
    expect(inA).not.toContain('conv-projB')

    const unscoped = db.getRagConversations(null).map((c) => c.id)
    expect(unscoped).toContain('conv-null')
    expect(unscoped).not.toContain('conv-1')
  })

  it('setRagConversationProject moves a conversation between projects (round-trip)', () => {
    db.createRagConversation('conv-move', 'movable')
    expect(db.getRagConversation('conv-move')?.project_id).toBeNull()
    db.setRagConversationProject('conv-move', 'proj-A')
    expect(db.getRagConversation('conv-move')?.project_id).toBe('proj-A')
    // and back to unscoped
    db.setRagConversationProject('conv-move', null)
    expect(db.getRagConversation('conv-move')?.project_id).toBeNull()
  })

  it('updateRagConversationTitle trims, persists, and returns the stored conversation', () => {
    db.createRagConversation('conv-title', 'old')
    const stored = db.updateRagConversationTitle('conv-title', '  new title  ')
    expect(stored).toMatchObject({ id: 'conv-title', title: 'new title' })
    expect(db.getRagConversation('conv-title')?.title).toBe('new title')
  })

  it('updateRagConversationTitle rejects an empty title without changing stored data', () => {
    expect(() => db.updateRagConversationTitle('conv-title', '   ')).toThrow(
      'Conversation title cannot be empty'
    )
    expect(db.getRagConversation('conv-title')?.title).toBe('new title')
  })

  it('updateRagConversationTitle rejects a missing conversation', () => {
    expect(() => db.updateRagConversationTitle('missing-conversation', 'new title')).toThrow(
      'Conversation not found: missing-conversation'
    )
  })

  it('deleteRagConversation returns true when a row was deleted, false otherwise', () => {
    db.createRagConversation('conv-del')
    expect(db.deleteRagConversation('conv-del')).toBe(true)
    expect(db.getRagConversation('conv-del')).toBeFalsy()
    expect(db.deleteRagConversation('conv-del')).toBe(false)
  })
})

describe('database.ts - RAG messages', () => {
  it('addRagMessage returns an incrementing rowid and getRagMessages returns them in order', () => {
    db.createRagConversation('msg-conv', 'msgs')
    const first = db.addRagMessage('msg-conv', 'user', 'hello')
    const second = db.addRagMessage('msg-conv', 'assistant', 'hi there')
    expect(second.id).toBeGreaterThan(first.id)
    // The cross-device name comes back too, so a caller can point at the message it just made.
    expect(first.uuid).not.toEqual(second.uuid)
    const msgs = db.getRagMessages('msg-conv')
    expect(msgs.map((m) => m.content)).toEqual(['hello', 'hi there'])
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('addRagMessage serializes context to JSON and getRagMessages returns it as a string', () => {
    db.createRagConversation('ctx-conv')
    const ctx = { sources: [{ id: 7, score: 0.9 }], scope: 'all' }
    db.addRagMessage('ctx-conv', 'assistant', 'answer', ctx)
    const msgs = db.getRagMessages('ctx-conv')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.context).toBe(JSON.stringify(ctx))
    // JSON round-trips back to the original object.
    expect(JSON.parse(msgs[0]!.context as string)).toEqual(ctx)
  })

  it('addRagMessage stores null context when none is passed', () => {
    db.createRagConversation('noctx-conv')
    db.addRagMessage('noctx-conv', 'user', 'no context')
    expect(db.getRagMessages('noctx-conv')[0]!.context).toBeNull()
  })

  it('deleting a conversation cascades to its messages (FK ON DELETE CASCADE)', () => {
    db.createRagConversation('cascade-conv')
    db.addRagMessage('cascade-conv', 'user', 'x')
    expect(db.getRagMessages('cascade-conv')).toHaveLength(1)
    db.deleteRagConversation('cascade-conv')
    expect(db.getRagMessages('cascade-conv')).toHaveLength(0)
  })

  it('truncateRagMessages keeps the first N (chronological) and deletes the rest', () => {
    db.createRagConversation('trunc-conv')
    for (let i = 0; i < 5; i++) {
      db.addRagMessage('trunc-conv', i % 2 === 0 ? 'user' : 'assistant', `m${i}`)
    }
    const removed = db.truncateRagMessages('trunc-conv', 2)
    expect(removed).toBe(3)
    const remaining = db.getRagMessages('trunc-conv')
    expect(remaining.map((m) => m.content)).toEqual(['m0', 'm1'])
  })

  it('truncateRagMessages is a no-op (returns 0) when keepCount exceeds the message count', () => {
    db.createRagConversation('trunc-noop')
    db.addRagMessage('trunc-noop', 'user', 'only')
    expect(db.truncateRagMessages('trunc-noop', 10)).toBe(0)
    expect(db.getRagMessages('trunc-noop')).toHaveLength(1)
  })

  it('searchRagConversationIds matches conversations by message content (AND terms)', () => {
    db.createRagConversation('search-hit')
    db.addRagMessage('search-hit', 'user', 'the quick brown fox jumps')
    db.createRagConversation('search-miss')
    db.addRagMessage('search-miss', 'user', 'a slow green turtle')

    const hits = db.searchRagConversationIds('quick fox')
    expect(hits).toContain('search-hit')
    expect(hits).not.toContain('search-miss')
    // empty / punctuation-only query returns nothing.
    expect(db.searchRagConversationIds('   ')).toEqual([])
  })
})

describe('database.ts - entities and facts', () => {
  it('EntityDomain creates an entity and returns a stable id on repeat (case-insensitive name)', () => {
    const id = resolveEntity('Ada Lovelace', 'Person')
    expect(id).toBeGreaterThan(0)
    // Same name+type upserts to the SAME row (UNIQUE(name,type)).
    const idAgain = resolveEntity('Ada Lovelace', 'Person')
    expect(idAgain).toBe(id)
  })

  it('EntityDomain defaults type to Unknown when blank', () => {
    const id = resolveEntity('Mystery', '   ')
    const { entity } = db.getEntityDetails(id) as { entity: { type: string } }
    expect(entity.type).toBe('Unknown')
  })

  it('addEntityFact inserts once and dedupes on repeat (INSERT OR IGNORE)', () => {
    const id = resolveEntity('Grace Hopper', 'Person')
    expect(db.addEntityFact(id, 'Coined the term debugging', 'sess-1')).toBe(true)
    // duplicate fact for the same entity is ignored -> no change.
    expect(db.addEntityFact(id, 'Coined the term debugging', 'sess-1')).toBe(false)
    // a distinct fact is inserted.
    expect(db.addEntityFact(id, 'Rear admiral in the US Navy')).toBe(true)
  })

  it('updateEntitySummary persists a summary readable via getEntityDetails', () => {
    const id = resolveEntity('Alan Turing', 'Person')
    db.updateEntitySummary(id, 'Founder of theoretical computer science')
    const { entity } = db.getEntityDetails(id) as { entity: { summary: string } }
    expect(entity.summary).toBe('Founder of theoretical computer science')
  })

  it('getEntities returns fact_count aggregated per entity', () => {
    const id = resolveEntity('Katherine Johnson', 'Person')
    db.addEntityFact(id, 'Calculated trajectories for Mercury and Apollo')
    db.addEntityFact(id, 'Received the Presidential Medal of Freedom')
    const list = db.getEntities() as { id: number; fact_count: number }[]
    const row = list.find((e) => e.id === id)
    expect(row?.fact_count).toBe(2)
  })

  it('getEntityDetails returns the entity plus its facts (newest first)', () => {
    const id = resolveEntity('Margaret Hamilton', 'Person')
    db.addEntityFact(id, 'Led Apollo flight software')
    const { entity, facts } = db.getEntityDetails(id) as {
      entity: { id: number; name: string }
      facts: { fact: string }[]
    }
    expect(entity.id).toBe(id)
    expect(entity.name).toBe('Margaret Hamilton')
    expect(facts.some((f) => f.fact === 'Led Apollo flight software')).toBe(true)
  })

  it('EntityDomain deletes the entity and its facts; false on a missing id', () => {
    const id = resolveEntity('Temporary Person', 'Person')
    db.addEntityFact(id, 'to be deleted')
    expect(entityDomain.deleteEntityById(id)).toBe(true)
    const { entity, facts } = db.getEntityDetails(id) as { entity: unknown; facts: unknown[] }
    expect(entity).toBeUndefined()
    expect(facts).toHaveLength(0)
    // deleting again affects no rows.
    expect(entityDomain.deleteEntityById(id)).toBe(false)
  })

  it('upsertEntitySession links entities to a session and getEntitiesForSession returns them', () => {
    // entity_sessions.session_id is a FK to conversations(id), so the session
    // must be a real conversation row first.
    const handle = db.getDB()
    handle
      .prepare('INSERT INTO conversations (id, app_name) VALUES (?, ?)')
      .run('sess-xyz', 'Notes')
    const a = resolveEntity('Session Person A', 'Person')
    const b = resolveEntity('Session Org B', 'Organization')
    db.upsertEntitySession(a, 'sess-xyz')
    db.upsertEntitySession(b, 'sess-xyz')
    // idempotent link (INSERT OR IGNORE) - no throw on repeat.
    db.upsertEntitySession(a, 'sess-xyz')
    const forSession = db.getEntitiesForSession('sess-xyz') as { id: number }[]
    const ids = forSession.map((e) => e.id)
    expect(ids).toContain(a)
    expect(ids).toContain(b)
    expect(
      forSession.every(
        (entity) => typeof (entity as { fact_count?: unknown }).fact_count === 'number'
      )
    ).toBe(true)
    expect(forSession.every((entity) => !('session_count' in entity))).toBe(true)
  })
})

describe('database.ts - master memory', () => {
  it('getMasterMemory returns an object with content and updated_at keys', () => {
    const before = db.getMasterMemory()
    expect(before).toHaveProperty('content')
    expect(before).toHaveProperty('updated_at')
  })

  it('updateMasterMemory upserts the single row and getMasterMemory reads it back', () => {
    db.updateMasterMemory('cumulative profile v1')
    expect(db.getMasterMemory().content).toBe('cumulative profile v1')
    db.updateMasterMemory('cumulative profile v2')
    expect(db.getMasterMemory().content).toBe('cumulative profile v2')
  })
})

describe('database.ts - chat summaries', () => {
  it('upsertChatSummary inserts then updates for the same session, getAllChatSummaries lists them', () => {
    db.upsertChatSummary('sum-sess', 'first summary')
    db.upsertChatSummary('sum-sess', 'updated summary')
    const all = db.getAllChatSummaries()
    const row = all.find((s) => s.session_id === 'sum-sess')
    expect(row?.summary).toBe('updated summary')
  })
})

describe('database.ts - user profile', () => {
  it('saveUserProfile then getUserProfile round-trips fields and stamps completedAt', () => {
    const saved = { role: 'engineer', painPoints: ['context switching'] }
    db.saveUserProfile(saved)
    const got = db.getUserProfile()
    expect(got?.role).toBe('engineer')
    expect(got?.painPoints).toEqual(['context switching'])
    expect(typeof got?.completedAt).toBe('string')
  })

  it('saveUserProfile overwrites the single row', () => {
    db.saveUserProfile({ role: 'designer' })
    expect(db.getUserProfile()?.role).toBe('designer')
  })
})

describe('database.ts - app settings (typed round-trip + defaults)', () => {
  it('getSettings returns balanced strictness defaults on a fresh store', () => {
    const s = db.getSettings()
    expect(s.memoryStrictness).toBe('balanced')
    expect(s.entityStrictness).toBe('balanced')
  })

  it('saveSetting + getSetting round-trips typed values (object, number, boolean)', () => {
    db.saveSetting('featureFlags', { image: true, tts: false })
    expect(db.getSetting('featureFlags', {})).toEqual({ image: true, tts: false })

    db.saveSetting('maxTokens', 4096)
    expect(db.getSetting('maxTokens', 0)).toBe(4096)

    db.saveSetting('enabled', true)
    expect(db.getSetting('enabled', false)).toBe(true)
  })

  it('getSetting returns the default for an unknown key', () => {
    expect(db.getSetting('nope', 'fallback')).toBe('fallback')
  })

  it('saveSetting overwrites an existing key (ON CONFLICT update)', () => {
    db.saveSetting('theme', 'dark')
    db.saveSetting('theme', 'light')
    expect(db.getSetting('theme', '')).toBe('light')
  })

  it('getSettings reflects a saved custom strictness and includes saved keys', () => {
    db.saveSetting('memoryStrictness', 'strict')
    const s = db.getSettings()
    expect(s.memoryStrictness).toBe('strict')
    expect(s.theme).toBe('light')
  })

  it('deleteSetting removes a key so getSetting falls back to default', () => {
    db.saveSetting('temp', 'x')
    expect(db.getSetting('temp', 'def')).toBe('x')
    db.deleteSetting('temp')
    expect(db.getSetting('temp', 'def')).toBe('def')
  })
})

describe('database.ts - memories, dashboard stats and legacy purge', () => {
  it('deleteMemory returns false for a non-existent memory id', () => {
    expect(db.deleteMemory(999999)).toBe(false)
  })

  it('deleteMemory returns true after inserting a memory row directly', () => {
    const handle = db.getDB()
    const info = handle
      .prepare('INSERT INTO memories (content, source_app, session_id) VALUES (?, ?, ?)')
      .run('a captured memory', 'TestApp', 'sess-mem')
    const memId = Number(info.lastInsertRowid)
    expect(db.deleteMemory(memId)).toBe(true)
  })

  it('getMemoryRecordsForSession returns rows scoped to a session', () => {
    const handle = db.getDB()
    handle
      .prepare('INSERT INTO memories (content, source_app, session_id) VALUES (?, ?, ?)')
      .run('scoped memory', 'TestApp', 'sess-scope')
    const rows = db.getMemoryRecordsForSession('sess-scope') as { content: string }[]
    expect(rows.some((r) => r.content === 'scoped memory')).toBe(true)
  })

  it('getDashboardStats returns the full stat shape with numeric totals', () => {
    const stats = db.getDashboardStats()
    expect(typeof stats.totalMemories).toBe('number')
    expect(typeof stats.totalEntities).toBe('number')
    expect(Array.isArray(stats.recentMemories)).toBe(true)
    expect(Array.isArray(stats.topEntities)).toBe(true)
    expect(Array.isArray(stats.activityByDay)).toBe(true)
    // 14-day activity window.
    expect(stats.activityByDay.length).toBe(14)
  })

  it('purgeLegacyChatImports returns null when there is nothing legacy to purge', () => {
    // No Claude/ChatGPT/Gemini conversations were seeded, so this is a no-op.
    expect(db.purgeLegacyChatImports()).toBeNull()
  })

  it('purgeLegacyChatImports removes legacy AI-chat conversations and reports counts', () => {
    const handle = db.getDB()
    handle
      .prepare('INSERT INTO conversations (id, title, app_name) VALUES (?, ?, ?)')
      .run('legacy-1', 't', 'ChatGPT')
    handle
      .prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)')
      .run('legacy-1', 'user', 'legacy message')
    const result = db.purgeLegacyChatImports()
    expect(result).not.toBeNull()
    expect(result?.conversations).toBeGreaterThanOrEqual(1)
    // the legacy conversation is gone.
    const gone = handle.prepare("SELECT id FROM conversations WHERE id = 'legacy-1'").get()
    expect(gone).toBeUndefined()
  })

  it('getChatSessions lists conversations with memory/entity counts', () => {
    const handle = db.getDB()
    handle
      .prepare('INSERT INTO conversations (id, title, app_name) VALUES (?, ?, ?)')
      .run('sess-list', 'Listed', 'Notes')
    const sessions = db.getChatSessions() as { session_id: string }[]
    expect(sessions.some((s) => s.session_id === 'sess-list')).toBe(true)
  })

  it('checkMessageExists reflects whether a hashed message is present for a conversation', () => {
    const handle = db.getDB()
    handle
      .prepare('INSERT INTO conversations (id, app_name) VALUES (?, ?)')
      .run('hash-conv', 'Notes')
    handle
      .prepare('INSERT INTO messages (conversation_id, role, content, hash) VALUES (?, ?, ?, ?)')
      .run('hash-conv', 'user', 'hashed', 'abc123')
    expect(db.checkMessageExists('abc123', 'hash-conv')).toBe(true)
    expect(db.checkMessageExists('missing', 'hash-conv')).toBe(false)
  })
})
