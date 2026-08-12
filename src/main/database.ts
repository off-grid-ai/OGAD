// better-sqlite3-multiple-ciphers is a drop-in superset of better-sqlite3 that
// adds SQLCipher-style `PRAGMA key` encryption. Same API surface + types.
import Database from 'better-sqlite3-multiple-ciphers'
import { app, safeStorage } from 'electron'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { createSettingsStore, initializeSettingsStore } from './settings-store'
import { CORE_SYNC_ENTITIES, emitSyncMutation } from './sync-mutation'
import type {
  RagConversationContract,
  RagMessageContract,
  UserProfileContract
} from '../shared/ipc-contracts'

let db: Database.Database | null = null

// --- Encryption at rest (new DBs only) -------------------------------------
// The DB key can't live inside the DB (it gates opening it), so it's stored as a
// safeStorage-encrypted file alongside it. Policy:
//   • .dbkey present            → encrypted DB (created by us) → open with the key
//   • no .dbkey, DB file exists → legacy plaintext DB → open as-is (NO migration)
//   • neither                   → fresh install → generate a key + create encrypted
// If the OS can't provide real encryption (no Keychain), we fall back to plaintext
// so the app still works rather than refusing to open.
function loadOrCreateKey(dbPath: string): string | null {
  const keyFile = path.join(path.dirname(dbPath), '.dbkey')
  try {
    if (fs.existsSync(keyFile)) {
      const blob = fs.readFileSync(keyFile)
      return safeStorage.decryptString(blob)
    }
  } catch (e) {
    console.error('[db] failed to read DB key — opening without encryption', e)
    return null
  }
  // No key yet. Only create one (→ encrypted DB) if there's no existing DB to
  // migrate and the OS gives us real encryption.
  if (fs.existsSync(dbPath)) return null // legacy plaintext DB — leave it
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[db] OS encryption unavailable — creating plaintext DB')
      return null
    }
    const key = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(keyFile, safeStorage.encryptString(key), { mode: 0o600 })
    console.log('[db] created encrypted database key')
    return key
  } catch (e) {
    console.error('[db] failed to create DB key — creating plaintext DB', e)
    return null
  }
}

// Cosine similarity function for vector search
// Returns similarity between 0 and 1 (1 = identical)
function cosineSimilarity(v1Str: string, v2Str: string): number {
  try {
    const v1 = JSON.parse(v1Str) as number[]
    const v2 = JSON.parse(v2Str) as number[]

    if (v1.length !== v2.length) return 0

    let dotProduct = 0
    let normA = 0
    let normB = 0

    for (let i = 0; i < v1.length; i++) {
      // i < v1.length === v2.length (checked above), so both reads are in-bounds.
      dotProduct += v1[i]! * v2[i]!
      normA += v1[i]! * v1[i]!
      normB += v2[i]! * v2[i]!
    }

    if (normA === 0 || normB === 0) return 0
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
  } catch {
    return 0
  }
}

export function getDB(): Database.Database {
  if (db?.open) return db

  // better-sqlite3 keeps the Database object after close(), but every operation on
  // that object fails with "The database connection is not open". Tests, profile
  // lifecycle code, and shutdown/restart paths can legitimately close the shared
  // handle, so a closed cached instance must be treated as absent.
  db = null

  const dbPath = path.join(app.getPath('userData'), 'memories.db')
  console.log('Opening database at:', dbPath)

  const key = loadOrCreateKey(dbPath)
  db = new Database(dbPath)
  // PRAGMA key MUST run before any other access (it unlocks the file).
  if (key) {
    db.pragma(`key = '${key}'`)
    console.log('[db] opened with encryption at rest')
  }
  db.pragma('journal_mode = WAL')

  // Register custom function for vector search. Declare the two params EXPLICITLY:
  // better-sqlite3 derives the SQL arity from fn.length, and a rest param
  // (...args) has length 0 — so it registered as a 0-arg function and every
  // 2-arg call ("SELECT cosine_similarity(embedding, ?)") threw "wrong number of
  // arguments to function cosine_similarity()".
  db.function('cosine_similarity', (a: unknown, b: unknown) =>
    cosineSimilarity(a as string, b as string)
  )

  // Initialize Schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, -- UUID or "app-slug"
        title TEXT,
        app_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        role TEXT, -- 'user' | 'assistant'
        content TEXT,
        timestamp TEXT, -- Extracted timestamp like "6:57 PM"
        hash TEXT, -- SHA-256 of content for deduplication (legacy)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    -- Legacy 'memories' for vector search (optional link to message_id later)
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      raw_text TEXT, 
      source_app TEXT,
      session_id TEXT, 
      message_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      embedding TEXT 
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        content, 
        content='memories'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
      content,
      conversation_id UNINDEXED,
      content='messages',
      content_rowid='id'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS summary_fts USING fts5(
      summary,
      session_id UNINDEXED,
      content='chat_summaries'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS entity_fts USING fts5(
      name,
      summary,
      type,
      content='entities',
      content_rowid='id'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS entity_fact_fts USING fts5(
      fact,
      entity_id UNINDEXED,
      content='entity_facts',
      content_rowid='id'
    );

    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE,
      type TEXT NOT NULL DEFAULT 'Unknown',
      summary TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(name, type)
    );

    CREATE TABLE IF NOT EXISTS entity_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL,
      fact TEXT NOT NULL,
      source_session_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(entity_id, fact),
      FOREIGN KEY(entity_id) REFERENCES entities(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS entity_sessions (
      entity_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(entity_id, session_id),
      FOREIGN KEY(entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY(session_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS entity_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_entity_id INTEGER NOT NULL,
      target_entity_id INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'cooccurrence',
      weight REAL NOT NULL DEFAULT 0,
      evidence_count INTEGER NOT NULL DEFAULT 0,
      last_session_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_entity_id, target_entity_id, type),
      FOREIGN KEY(source_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY(target_entity_id) REFERENCES entities(id) ON DELETE CASCADE
    );
  `)

  // Create Chat Summaries Table if not exists (migrating to conversations table eventually)
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_summaries (
      session_id TEXT PRIMARY KEY,
      summary TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)

  // Create Master Memory Table - cumulative summary of all summaries
  db.exec(`
    CREATE TABLE IF NOT EXISTS master_memory (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      content TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)

  // User Profile Table - stores onboarding questionnaire data as JSON
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)

  // RAG Conversations Table - stores chat sessions with the memory assistant
  db.exec(`
    CREATE TABLE IF NOT EXISTS rag_conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      origin_device_id TEXT,
      origin_device_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)

  // RAG Messages Table - stores messages in RAG conversations
  db.exec(`
    CREATE TABLE IF NOT EXISTS rag_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      context TEXT,
      origin_device_id TEXT,
      origin_device_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(conversation_id) REFERENCES rag_conversations(id) ON DELETE CASCADE
    );
  `)

  initializeSettingsStore(db)

  // Triggers to keep FTS in sync
  const triggers = [
    `CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memory_fts(rowid, content) VALUES (new.id, new.content);
    END;`,
    `CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, content) VALUES('delete', old.id, old.content);
    END;`,
    `CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO memory_fts(rowid, content) VALUES (new.id, new.content);
    END;`,

    `CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO message_fts(rowid, content, conversation_id) VALUES (new.id, new.content, new.conversation_id);
    END;`,
    `CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO message_fts(message_fts, rowid, content, conversation_id) VALUES('delete', old.id, old.content, old.conversation_id);
    END;`,
    `CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO message_fts(message_fts, rowid, content, conversation_id) VALUES('delete', old.id, old.content, old.conversation_id);
      INSERT INTO message_fts(rowid, content, conversation_id) VALUES (new.id, new.content, new.conversation_id);
    END;`,

    `CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON chat_summaries BEGIN
      INSERT INTO summary_fts(rowid, summary, session_id) VALUES (new.rowid, new.summary, new.session_id);
    END;`,
    `CREATE TRIGGER IF NOT EXISTS summaries_ad AFTER DELETE ON chat_summaries BEGIN
      INSERT INTO summary_fts(summary_fts, rowid, summary, session_id) VALUES('delete', old.rowid, old.summary, old.session_id);
    END;`,
    `CREATE TRIGGER IF NOT EXISTS summaries_au AFTER UPDATE ON chat_summaries BEGIN
      INSERT INTO summary_fts(summary_fts, rowid, summary, session_id) VALUES('delete', old.rowid, old.summary, old.session_id);
      INSERT INTO summary_fts(rowid, summary, session_id) VALUES (new.rowid, new.summary, new.session_id);
    END;`,

    `CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
      INSERT INTO entity_fts(rowid, name, summary, type) VALUES (new.id, new.name, new.summary, new.type);
    END;`,
    `CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
      INSERT INTO entity_fts(entity_fts, rowid, name, summary, type) VALUES('delete', old.id, old.name, old.summary, old.type);
    END;`,
    `CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
      INSERT INTO entity_fts(entity_fts, rowid, name, summary, type) VALUES('delete', old.id, old.name, old.summary, old.type);
      INSERT INTO entity_fts(rowid, name, summary, type) VALUES (new.id, new.name, new.summary, new.type);
    END;`,

    `CREATE TRIGGER IF NOT EXISTS entity_facts_ai AFTER INSERT ON entity_facts BEGIN
      INSERT INTO entity_fact_fts(rowid, fact, entity_id) VALUES (new.id, new.fact, new.entity_id);
    END;`,
    `CREATE TRIGGER IF NOT EXISTS entity_facts_ad AFTER DELETE ON entity_facts BEGIN
      INSERT INTO entity_fact_fts(entity_fact_fts, rowid, fact, entity_id) VALUES('delete', old.id, old.fact, old.entity_id);
    END;`,
    `CREATE TRIGGER IF NOT EXISTS entity_facts_au AFTER UPDATE ON entity_facts BEGIN
      INSERT INTO entity_fact_fts(entity_fact_fts, rowid, fact, entity_id) VALUES('delete', old.id, old.fact, old.entity_id);
      INSERT INTO entity_fact_fts(rowid, fact, entity_id) VALUES (new.id, new.fact, new.entity_id);
    END;`
  ]

  for (const trigger of triggers) {
    db.exec(trigger)
  }

  try {
    db.exec("INSERT INTO message_fts(message_fts) VALUES('rebuild')")
    db.exec("INSERT INTO summary_fts(summary_fts) VALUES('rebuild')")
    db.exec("INSERT INTO entity_fts(entity_fts) VALUES('rebuild')")
    db.exec("INSERT INTO entity_fact_fts(entity_fact_fts) VALUES('rebuild')")
  } catch {
    // Ignore rebuild errors
  }

  // Migration: Add timestamp column to messages if it doesn't exist
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN timestamp TEXT`)
  } catch {
    // Column already exists, ignore
  }

  // Migration: Add message_id column to memories if it doesn't exist
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN message_id INTEGER`)
  } catch {
    // Column already exists, ignore
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_message_id ON memories(message_id)')

  // Migration: Add name column to memories if it doesn't exist
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN name TEXT`)
  } catch {
    // Column already exists, ignore
  }

  // Migration: Add project_id to rag_conversations (chats can be scoped to a project)
  try {
    db.exec(`ALTER TABLE rag_conversations ADD COLUMN project_id TEXT`)
  } catch {
    // Column already exists, ignore
  }
  for (const column of ['origin_device_id', 'origin_device_name']) {
    try {
      db.exec(`ALTER TABLE rag_conversations ADD COLUMN ${column} TEXT`)
    } catch {
      // Column already exists, ignore
    }
  }

  // Migration: Add a stable UUID to rag_messages so chat messages can replicate across devices.
  //
  // WHY: `rag_messages.id` is INTEGER AUTOINCREMENT, which is device-local. Cross-device sync keys
  // every record by a globally-unique id, so device A's row 7 and device B's row 7 would look like
  // the SAME message and silently overwrite each other. The autoincrement id stays as the local
  // primary key; `uuid` is the cross-device identity. Mobile uses the same column name and the same
  // 'message' entity name — they must match or the two platforms will not converge.
  try {
    db.exec(`ALTER TABLE rag_messages ADD COLUMN uuid TEXT`)
  } catch {
    // Column already exists, ignore
  }
  for (const column of ['origin_device_id', 'origin_device_name']) {
    try {
      db.exec(`ALTER TABLE rag_messages ADD COLUMN ${column} TEXT`)
    } catch {
      // Column already exists, ignore
    }
  }
  // Backfill rows that predate the column. Done in JS because SQLite has no uuid() function.
  try {
    const needsUuid = db
      .prepare('SELECT id FROM rag_messages WHERE uuid IS NULL OR uuid = ?')
      .all('') as Array<{ id: number }>
    if (needsUuid.length > 0) {
      const assign = db.prepare('UPDATE rag_messages SET uuid = ? WHERE id = ?')
      for (const row of needsUuid) assign.run(crypto.randomUUID(), row.id)
    }
  } catch {
    // Table may not exist yet on a brand-new profile; the CREATE above covers that path.
  }
  // Unique so a replayed remote op upserts instead of duplicating. SQLite treats NULLs as
  // distinct, so this is safe to create even if a backfill ever misses a row.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_messages_uuid ON rag_messages(uuid)')

  return db
}

/** Run an idempotent schema migration (CREATE TABLE IF NOT EXISTS …) on the
 *  shared DB. Exposed so the pro package can create its own tables (observations,
 *  entities, approvals, …) without core knowing about them. */
export function runMigration(sql: string): void {
  getDB().exec(sql)
}

// === NEW API ACCESSORS ===

export interface ChatSessionRecord {
  session_id: string
  title: string | null
  source_app: string | null
  last_activity: string
  memory_count: number
  entity_count: number
  summary: string | null
}

export interface MessageRecord {
  id: number
  conversation_id: string
  role: string | null
  content: string | null
  timestamp: string | null
  hash: string | null
  created_at: string
}

export interface MemoryRecord {
  id: number
  content: string
  raw_text: string | null
  source_app: string | null
  session_id: string | null
  message_id: number | null
  created_at: string
  name: string | null
}

export function getChatSessions(appName?: string): ChatSessionRecord[] {
  const db = getDB()
  // Query conversations with memory and entity counts instead of message count
  let query = `
        SELECT 
            c.id as session_id,
            c.title,
            c.app_name as source_app,
            c.updated_at as last_activity,
            (SELECT COUNT(*) FROM memories mem WHERE mem.session_id = c.id) as memory_count,
            (SELECT COUNT(DISTINCT es.entity_id) FROM entity_sessions es WHERE es.session_id = c.id) as entity_count,
            (SELECT summary FROM chat_summaries cs WHERE cs.session_id = c.id) as summary
        FROM conversations c
    `

  if (appName && appName !== 'All') {
    query += ` WHERE c.app_name LIKE ? `
  }

  query += ` ORDER BY c.updated_at DESC`

  const stmt = db.prepare(query)
  if (appName && appName !== 'All') {
    return stmt.all(`%${appName}%`) as ChatSessionRecord[]
  } else {
    return stmt.all() as ChatSessionRecord[]
  }
}

export function upsertChatSummary(sessionId: string, summary: string): void {
  const db = getDB()
  const stmt = db.prepare(`
        INSERT INTO chat_summaries (session_id, summary, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(session_id) DO UPDATE SET
            summary = excluded.summary,
            updated_at = excluded.updated_at
    `)
  stmt.run(sessionId, summary)
}

export function getMemoriesForSession(sessionId: string, limit: number = 200): MessageRecord[] {
  const db = getDB()
  // Fetch from new 'messages' table
  const stmt = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?'
  )
  const messages = stmt.all(sessionId, limit) as MessageRecord[]

  // Map to old Memory interface shape if needed by UI, or UI updates?
  // UI expects { id, content, raw_text, source_app, created_at, role? }
  // We added 'role' to messages.
  return messages
}

export function getMemoryRecordsForSession(sessionId: string, limit: number = 200): MemoryRecord[] {
  const db = getDB()
  const stmt = db.prepare(
    'SELECT * FROM memories WHERE session_id = ? ORDER BY created_at ASC LIMIT ?'
  )
  return stmt.all(sessionId, limit) as MemoryRecord[]
}

export function checkMessageExists(hash: string, conversationId: string): boolean {
  const db = getDB()
  const stmt = db.prepare('SELECT id FROM messages WHERE conversation_id = ? AND hash = ? LIMIT 1')
  const result = stmt.get(conversationId, hash)
  return !!result
}

// === MASTER MEMORY ===

export function getMasterMemory(): { content: string | null; updated_at: string | null } {
  const db = getDB()
  const result = db.prepare('SELECT content, updated_at FROM master_memory WHERE id = 1').get() as
    | { content: string; updated_at: string }
    | undefined
  return result || { content: null, updated_at: null }
}

export function updateMasterMemory(content: string): void {
  const db = getDB()
  const stmt = db.prepare(`
        INSERT INTO master_memory (id, content, updated_at)
        VALUES (1, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
            content = excluded.content,
            updated_at = excluded.updated_at
    `)
  stmt.run(content)
}

// One-shot, idempotent purge of the legacy "My Memories" data: the AI-chat
// conversations the old watcher scraped (Claude / ChatGPT / Gemini, web +
// desktop) and everything derived from them — messages, vector memories,
// summaries, entity facts, and entities left orphaned afterwards. The shared
// `entities` table is ALSO fed by the current screen-capture/observation
// pipeline, so we only drop entities with no remaining link in entity_sessions,
// entity_facts, OR observation_entities. Once the legacy conversations are gone
// this finds nothing and is a no-op, so it's safe to call on every startup.
export function purgeLegacyChatImports(): Record<string, number> | null {
  const db = getDB()
  const legacy = db
    .prepare(
      `
        SELECT id FROM conversations
        WHERE app_name IN ('Claude.ai','ChatGPT','Gemini')
           OR LOWER(app_name) LIKE '%claude%'
           OR LOWER(app_name) LIKE '%chatgpt%'
           OR LOWER(app_name) LIKE '%gemini%'
    `
    )
    .all() as { id: string }[]
  const ids = legacy.map((r) => r.id)
  if (ids.length === 0) return null

  const ph = ids.map(() => '?').join(',')
  const hasObsEntities = !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='observation_entities'`)
    .get()

  const run = db.transaction(() => {
    const counts: Record<string, number> = {}
    const messages = db
      .prepare(`SELECT COUNT(*) AS c FROM messages WHERE conversation_id IN (${ph})`)
      .get(...ids) as { c: number }
    counts.messages = messages.c
    counts.memories = db
      .prepare(`DELETE FROM memories WHERE session_id IN (${ph})`)
      .run(...ids).changes
    counts.summaries = db
      .prepare(`DELETE FROM chat_summaries WHERE session_id IN (${ph})`)
      .run(...ids).changes
    counts.entityFacts = db
      .prepare(`DELETE FROM entity_facts WHERE source_session_id IN (${ph})`)
      .run(...ids).changes
    // Cascades messages + entity_sessions (both FK conversations ON DELETE CASCADE).
    counts.conversations = db
      .prepare(`DELETE FROM conversations WHERE id IN (${ph})`)
      .run(...ids).changes
    // Drop entities now orphaned across every link table (keeps current-capture entities).
    const orphanGuard = hasObsEntities
      ? `id NOT IN (SELECT entity_id FROM entity_sessions)
               AND id NOT IN (SELECT entity_id FROM entity_facts)
               AND id NOT IN (SELECT entity_id FROM observation_entities)`
      : `id NOT IN (SELECT entity_id FROM entity_sessions)
               AND id NOT IN (SELECT entity_id FROM entity_facts)`
    counts.entitiesDeleted = hasObsEntities
      ? db.prepare(`DELETE FROM entities WHERE ${orphanGuard}`).run().changes
      : 0 // without obs links we can't tell current from legacy — leave them
    // The stale consolidated profile is gone for good.
    counts.masterMemory = db.prepare(`DELETE FROM master_memory`).run().changes
    // Rebuild external-content FTS indexes so they don't point at deleted rows.
    for (const t of ['memory_fts', 'message_fts', 'summary_fts', 'entity_fts', 'entity_fact_fts']) {
      try {
        db.prepare(`INSERT INTO ${t}(${t}) VALUES('rebuild')`).run()
      } catch {
        /* table may be absent */
      }
    }
    return counts
  })
  const result = run()
  console.log('[DB] Purged legacy My Memories chat imports:', result)
  return result
}

export function getAllChatSummaries(): { session_id: string; summary: string }[] {
  const db = getDB()
  const stmt = db.prepare(
    'SELECT session_id, summary FROM chat_summaries WHERE summary IS NOT NULL'
  )
  return stmt.all() as { session_id: string; summary: string }[]
}

// === ENTITIES ===

/**
 * SQLite persistence primitive for EntityDomain. Callers must use
 * resolveEntityCandidate() so admission cannot be bypassed.
 */
export function resolveEntityRecord(
  name: string,
  type: string = 'Unknown'
): { entityId: number; created: boolean } {
  const db = getDB()
  const resolvedType = type.trim() || 'Unknown'
  const resolve = db.transaction(() => {
    const insert = db
      .prepare(
        `INSERT INTO entities (name, type, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(name, type) DO NOTHING`
      )
      .run(name, resolvedType)
    if (insert.changes === 0) {
      db.prepare(
        'UPDATE entities SET updated_at = CURRENT_TIMESTAMP WHERE name = ? AND type = ?'
      ).run(name, resolvedType)
    }
    const row = db
      .prepare('SELECT id FROM entities WHERE name = ? AND type = ?')
      .get(name, resolvedType) as { id: number } | undefined
    return { entityId: row?.id ?? 0, created: insert.changes > 0 }
  })
  return resolve()
}

export function updateEntitySummary(entityId: number, summary: string): void {
  const db = getDB()
  const stmt = db.prepare(`
      UPDATE entities SET summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `)
  stmt.run(summary, entityId)
}

export function addEntityFact(entityId: number, fact: string, sessionId?: string): boolean {
  const db = getDB()
  const stmt = db.prepare(`
      INSERT OR IGNORE INTO entity_facts (entity_id, fact, source_session_id)
      VALUES (?, ?, ?)
    `)
  const info = stmt.run(entityId, fact.trim(), sessionId || null)
  return info.changes > 0
}

export function upsertEntitySession(entityId: number, sessionId: string): void {
  const db = getDB()
  const stmt = db.prepare(`
      INSERT OR IGNORE INTO entity_sessions (entity_id, session_id)
      VALUES (?, ?)
    `)
  stmt.run(entityId, sessionId)
}


export interface EntityRecord {
  id: number
  name: string
  type: string
  summary: string | null
  updated_at: string
}

export interface EntityListRecord extends EntityRecord {
  fact_count: number
  session_count: number
}

export interface SessionEntityRecord extends EntityRecord {
  fact_count: number
}

export interface EntityFactRecord {
  id: number
  fact: string
  source_session_id: string | null
  created_at: string
}

export interface EntityDetailsRecord {
  entity: (EntityRecord & Record<string, unknown>) | undefined
  facts: EntityFactRecord[]
}


export function getEntities(appName?: string): EntityListRecord[] {
  const db = getDB()
  let query = `
      SELECT 
        e.id,
        e.name,
        e.type,
        e.summary,
        e.updated_at,
        COUNT(DISTINCT f.id) as fact_count,
        COUNT(DISTINCT es.session_id) as session_count
      FROM entities e
      LEFT JOIN entity_facts f ON f.entity_id = e.id
      LEFT JOIN entity_sessions es ON es.entity_id = e.id
      LEFT JOIN conversations c ON es.session_id = c.id
    `

  const params: unknown[] = []
  if (appName && appName !== 'All') {
    query += ` WHERE c.app_name LIKE ? `
    params.push(`%${appName}%`)
  }

  query += ` GROUP BY e.id ORDER BY e.updated_at DESC`
  const stmt = db.prepare(query)
  return stmt.all(...params) as EntityListRecord[]
}

export function getEntityDetails(entityId: number, appName?: string): EntityDetailsRecord {
  const db = getDB()
  const entity = db.prepare('SELECT * FROM entities WHERE id = ?').get(entityId) as
    | (EntityRecord & Record<string, unknown>)
    | undefined

  let factsQuery = `
      SELECT f.id, f.fact, f.source_session_id, f.created_at
      FROM entity_facts f
      LEFT JOIN conversations c ON f.source_session_id = c.id
      WHERE f.entity_id = ?
    `
  const params: unknown[] = [entityId]
  if (appName && appName !== 'All') {
    factsQuery += ` AND c.app_name LIKE ? `
    params.push(`%${appName}%`)
  }
  factsQuery += ` ORDER BY f.created_at DESC`

  const facts = db.prepare(factsQuery).all(...params) as EntityFactRecord[]
  return { entity, facts }
}

export function getEntitiesForSession(sessionId: string): SessionEntityRecord[] {
  const db = getDB()
  const stmt = db.prepare(`
      SELECT e.id, e.name, e.type, e.summary, e.updated_at,
             COUNT(DISTINCT f.id) as fact_count
      FROM entities e
      JOIN entity_sessions es ON es.entity_id = e.id
      LEFT JOIN entity_facts f ON f.entity_id = e.id
      WHERE es.session_id = ?
      GROUP BY e.id
      ORDER BY e.updated_at DESC
    `)
  return stmt.all(sessionId) as SessionEntityRecord[]
}


// === DELETE FUNCTIONS ===

/**
 * SQLite persistence primitive for EntityDomain. Core does not rely on foreign
 * key enforcement here: native-driver defaults and historical profiles can
 * differ, so all core dependants are removed explicitly in one transaction.
 */
export function deleteEntityRecord(entityId: number): boolean {
  const db = getDB()
  const remove = db.transaction(() => {
    db.prepare('DELETE FROM entity_edges WHERE source_entity_id = ? OR target_entity_id = ?').run(
      entityId,
      entityId
    )
    db.prepare('DELETE FROM entity_facts WHERE entity_id = ?').run(entityId)
    db.prepare('DELETE FROM entity_sessions WHERE entity_id = ?').run(entityId)
    return db.prepare('DELETE FROM entities WHERE id = ?').run(entityId).changes > 0
  })
  const deleted = remove()
  console.log(`Deleted entity ${entityId}, deleted: ${deleted}`)
  return deleted
}

export function deleteMemory(memoryId: number): boolean {
  const db = getDB()
  const stmt = db.prepare('DELETE FROM memories WHERE id = ?')
  const info = stmt.run(memoryId)
  console.log(`Deleted memory ${memoryId}, changes: ${info.changes}`)
  return info.changes > 0
}

// === DASHBOARD STATS ===

export interface DashboardStats {
  totalChats: number
  totalMemories: number
  totalEntities: number
  totalRelationships: number
  totalMessages: number
  todayChats: number
  todayMemories: number
  todayEntities: number
  totalFacts: number
  recentChats: Array<{
    session_id: string
    title: string | null
    app_name: string
    memory_count: number
    entity_count: number
    updated_at: string
  }>
  recentMemories: Array<{
    id: number
    content: string
    source_app: string
    created_at: string
  }>
  topEntities: Array<{
    id: number
    name: string
    type: string
    fact_count: number
    session_count: number
  }>
  entityTypeCounts: Array<{
    type: string
    count: number
  }>
  appDistribution: Array<{
    app_name: string
    chat_count: number
    memory_count: number
  }>
  activityByDay: Array<{
    date: string
    chats: number
    memories: number
  }>
}

export function getDashboardStats(): DashboardStats {
  const db = getDB()

  // Total counts
  const totalChats = (
    db.prepare('SELECT COUNT(*) as count FROM conversations').get() as { count: number }
  ).count
  const totalMemories = (
    db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }
  ).count
  const totalEntities = (
    db.prepare('SELECT COUNT(*) as count FROM entities').get() as { count: number }
  ).count
  const totalRelationships = (
    db.prepare('SELECT COUNT(*) as count FROM entity_edges').get() as { count: number }
  ).count
  const totalMessages = (
    db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number }
  ).count
  const totalFacts = (
    db.prepare('SELECT COUNT(*) as count FROM entity_facts').get() as { count: number }
  ).count

  // Today's activity (convert stored timestamps to localtime before comparing)
  const todayChats = (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM conversations WHERE date(updated_at, 'localtime') = date('now', 'localtime')`
      )
      .get() as { count: number }
  ).count
  const todayMemories = (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM memories WHERE date(created_at, 'localtime') = date('now', 'localtime')`
      )
      .get() as { count: number }
  ).count
  const todayEntities = (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM entities WHERE date(created_at, 'localtime') = date('now', 'localtime')`
      )
      .get() as { count: number }
  ).count

  // Recent chats (top 5)
  const recentChats = db
    .prepare(
      `
        SELECT 
            c.id as session_id,
            c.title,
            c.app_name,
            c.updated_at,
            (SELECT COUNT(*) FROM memories m WHERE m.session_id = c.id) as memory_count,
            (SELECT COUNT(DISTINCT es.entity_id) FROM entity_sessions es WHERE es.session_id = c.id) as entity_count
        FROM conversations c
        ORDER BY c.updated_at DESC
        LIMIT 5
    `
    )
    .all() as DashboardStats['recentChats']

  // Recent memories (top 5)
  const recentMemories = db
    .prepare(
      `
        SELECT id, content, source_app, created_at
        FROM memories
        ORDER BY created_at DESC
        LIMIT 5
    `
    )
    .all() as DashboardStats['recentMemories']

  // Top entities by fact count
  const topEntities = db
    .prepare(
      `
        SELECT 
            e.id,
            e.name,
            e.type,
            COUNT(DISTINCT f.id) as fact_count,
            COUNT(DISTINCT es.session_id) as session_count
        FROM entities e
        LEFT JOIN entity_facts f ON f.entity_id = e.id
        LEFT JOIN entity_sessions es ON es.entity_id = e.id
        GROUP BY e.id
        ORDER BY fact_count DESC
        LIMIT 6
    `
    )
    .all() as DashboardStats['topEntities']

  // Entity type distribution
  const entityTypeCounts = db
    .prepare(
      `
        SELECT type, COUNT(*) as count
        FROM entities
        GROUP BY type
        ORDER BY count DESC
        LIMIT 8
    `
    )
    .all() as DashboardStats['entityTypeCounts']

  // App distribution
  const appDistribution = db
    .prepare(
      `
        SELECT 
            COALESCE(c.app_name, 'Unknown') as app_name,
            COUNT(DISTINCT c.id) as chat_count,
            COUNT(DISTINCT m.id) as memory_count
        FROM conversations c
        LEFT JOIN memories m ON m.session_id = c.id
        GROUP BY c.app_name
        ORDER BY chat_count DESC
    `
    )
    .all() as DashboardStats['appDistribution']

  // Activity by day (last 14 days, using localtime)
  const activityByDay = db
    .prepare(
      `
        WITH RECURSIVE dates(date) AS (
            SELECT date('now', 'localtime', '-13 days')
            UNION ALL
            SELECT date(date, '+1 day')
            FROM dates
            WHERE date < date('now', 'localtime')
        )
        SELECT 
            dates.date,
            (SELECT COUNT(*) FROM conversations WHERE date(updated_at, 'localtime') = dates.date) as chats,
            (SELECT COUNT(*) FROM memories WHERE date(created_at, 'localtime') = dates.date) as memories
        FROM dates
        ORDER BY dates.date ASC
    `
    )
    .all() as DashboardStats['activityByDay']

  return {
    totalChats,
    totalMemories,
    totalEntities,
    totalRelationships,
    totalMessages,
    totalFacts,
    todayChats,
    todayMemories,
    todayEntities,
    recentChats,
    recentMemories,
    topEntities,
    entityTypeCounts,
    appDistribution,
    activityByDay
  }
}

// === USER PROFILE ===

export type UserProfile = UserProfileContract

export function getUserProfile(): UserProfile | null {
  const db = getDB()
  const row = db.prepare('SELECT data FROM user_profile WHERE id = 1').get() as
    | { data: string }
    | undefined
  if (!row) return null
  try {
    return JSON.parse(row.data) as UserProfile
  } catch {
    return null
  }
}

export function saveUserProfile(profile: UserProfile): void {
  const db = getDB()
  const now = new Date().toISOString()
  const dataWithTimestamp = { ...profile, completedAt: now }
  const json = JSON.stringify(dataWithTimestamp)

  db.prepare(
    `
        INSERT INTO user_profile (id, data, updated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = ?, updated_at = ?
    `
  ).run(json, now, json, now)
}

// === RAG CONVERSATIONS ===

export type RagConversation = RagConversationContract
export type RagMessage = RagMessageContract

export function createRagConversation(
  id: string,
  title?: string,
  projectId?: string | null
): string {
  const db = getDB()
  db.prepare(
    `
        INSERT INTO rag_conversations (id, title, project_id, created_at, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `
  ).run(id, title || null, projectId || null)
  emitSyncMutation({ entity: CORE_SYNC_ENTITIES.conversation, entityId: id, kind: 'put' })
  return id
}

export function getRagConversations(projectId?: string | null): RagConversation[] {
  const db = getDB()
  const where =
    projectId === undefined
      ? ''
      : projectId === null
        ? 'WHERE rc.project_id IS NULL'
        : 'WHERE rc.project_id = ?'
  const stmt = db.prepare(`
        SELECT
            rc.id,
            rc.title,
            rc.project_id,
            rc.origin_device_id,
            rc.origin_device_name,
            rc.created_at,
            rc.updated_at,
            (SELECT COUNT(*) FROM rag_messages rm WHERE rm.conversation_id = rc.id) as message_count,
            -- The last turn, for the list's one-line preview. A conversation synced from a phone
            -- otherwise listed as a title with nothing under it.
            (SELECT rm.role FROM rag_messages rm WHERE rm.conversation_id = rc.id
               ORDER BY rm.created_at DESC, rm.id DESC LIMIT 1) as last_role,
            (SELECT rm.content FROM rag_messages rm WHERE rm.conversation_id = rc.id
               ORDER BY rm.created_at DESC, rm.id DESC LIMIT 1) as last_content
        FROM rag_conversations rc
        ${where}
        ORDER BY rc.updated_at DESC
    `)
  return (projectId ? stmt.all(projectId) : stmt.all()) as RagConversation[]
}

export function getRagConversation(id: string): RagConversation | null {
  const db = getDB()
  return db
    .prepare(
      `
        SELECT id, title, project_id, origin_device_id, origin_device_name, created_at, updated_at
        FROM rag_conversations
        WHERE id = ?
    `
    )
    .get(id) as RagConversation | null
}

export function setRagConversationProject(id: string, projectId: string | null): void {
  const db = getDB()
  const result = db
    .prepare(
      `UPDATE rag_conversations SET project_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
    .run(projectId, id)
  if (result.changes === 1) {
    emitSyncMutation({ entity: CORE_SYNC_ENTITIES.conversation, entityId: id, kind: 'put' })
  }
}

/** Conversation ids whose MESSAGE CONTENT matches a query (all terms, AND) — so the
 *  chat-list search can match what was said, not just the title. */
export function searchRagConversationIds(query: string): string[] {
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 6)
  if (!terms.length) return []
  const where = terms.map(() => 'lower(content) LIKE ?').join(' AND ')
  const rows = getDB()
    .prepare(`SELECT DISTINCT conversation_id FROM rag_messages WHERE ${where}`)
    .all(...terms.map((t) => `%${t}%`)) as { conversation_id: string }[]
  return rows.map((r) => r.conversation_id)
}

/**
 * Recent messages from OTHER chats in the same project — lets a project chat
 * reference what was discussed in sibling conversations. Returns chronological.
 */
export function getProjectChatHistory(
  projectId: string,
  excludeConversationId: string,
  limit = 12
): { role: string; content: string; title: string | null }[] {
  const db = getDB()
  // Project memory spans every sibling chat in the project (rag_conversations),
  // so context isn't lost across chats in the project.
  const rows = db
    .prepare(
      `
        SELECT rm.role AS role, rm.content AS content, rc.title AS title, rm.created_at AS created_at
        FROM rag_messages rm
        JOIN rag_conversations rc ON rc.id = rm.conversation_id
        WHERE rc.project_id = ? AND rm.conversation_id != ?
        ORDER BY rm.created_at DESC
        LIMIT ?
    `
    )
    .all(projectId, excludeConversationId, limit) as {
    role: string
    content: string
    title: string | null
    created_at: string
  }[]
  return rows.map(({ role, content, title }) => ({ role, content, title })).reverse()
}

export function updateRagConversationTitle(id: string, title: string): RagConversation {
  const normalizedTitle = title.trim()
  if (!normalizedTitle) {
    throw new Error('Conversation title cannot be empty')
  }
  const db = getDB()
  const result = db
    .prepare(
      `
        UPDATE rag_conversations 
        SET title = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
    `
    )
    .run(normalizedTitle, id)
  if (result.changes !== 1) {
    throw new Error(`Conversation not found: ${id}`)
  }
  emitSyncMutation({ entity: CORE_SYNC_ENTITIES.conversation, entityId: id, kind: 'put' })
  return getRagConversation(id)!
}

export function deleteRagConversation(id: string): boolean {
  const db = getDB()
  const messages = db
    .prepare('SELECT uuid FROM rag_messages WHERE conversation_id = ?')
    .all(id) as Array<{ uuid: string }>
  // FKs are off (no PRAGMA foreign_keys), so rag_messages' ON DELETE CASCADE never
  // fires — delete the conversation's messages explicitly or they orphan (D23).
  db.prepare('DELETE FROM rag_messages WHERE conversation_id = ?').run(id)
  const info = db.prepare('DELETE FROM rag_conversations WHERE id = ?').run(id)
  if (info.changes === 0) return false
  for (const message of messages) {
    emitSyncMutation({
      entity: CORE_SYNC_ENTITIES.message,
      entityId: message.uuid,
      kind: 'delete'
    })
  }
  emitSyncMutation({ entity: CORE_SYNC_ENTITIES.conversation, entityId: id, kind: 'delete' })
  return true
}

/** The stored message: the device-local row id, and the uuid every device knows it by. */
export interface AddedRagMessage {
  id: number
  uuid: string
}

/**
 * The uuid is RETURNED, not discarded.
 *
 * It is the cross-device identity of the message, and it was minted here and thrown away, so a
 * caller could not name the message it had just created. Anything that had to point at that message
 * from elsewhere therefore pointed at something device-local instead - which is how a generated
 * image came to be named by an absolute path on one Mac.
 */
export function addRagMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  context?: unknown
): AddedRagMessage {
  const db = getDB()
  const contextJson = context ? JSON.stringify(context) : null
  const uuid = crypto.randomUUID()

  // uuid is the cross-device identity for sync (the autoincrement id is device-local).
  const info = db
    .prepare(
      `
        INSERT INTO rag_messages (uuid, conversation_id, role, content, context, created_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `
    )
    .run(uuid, conversationId, role, content, contextJson)

  // Update conversation updated_at timestamp
  db.prepare(
    `
        UPDATE rag_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `
  ).run(conversationId)

  emitSyncMutation({ entity: CORE_SYNC_ENTITIES.message, entityId: uuid, kind: 'put' })
  emitSyncMutation({
    entity: CORE_SYNC_ENTITIES.conversation,
    entityId: conversationId,
    kind: 'put'
  })
  return { id: Number(info.lastInsertRowid), uuid }
}

// Keep the first `keepCount` messages of a conversation (chronological) and
// delete the rest — used by regenerate/edit so old answers don't pile up.
export function truncateRagMessages(conversationId: string, keepCount: number): number {
  const db = getDB()
  const rows = db
    .prepare(`SELECT id, uuid FROM rag_messages WHERE conversation_id = ? ORDER BY id ASC`)
    .all(conversationId) as Array<{ id: number; uuid: string }>
  const toDelete = rows.slice(Math.max(0, keepCount))
  if (!toDelete.length) return 0
  const ph = toDelete.map(() => '?').join(',')
  const result = db
    .prepare(`DELETE FROM rag_messages WHERE id IN (${ph})`)
    .run(...toDelete.map(({ id }) => id))
  for (const message of toDelete) {
    emitSyncMutation({
      entity: CORE_SYNC_ENTITIES.message,
      entityId: message.uuid,
      kind: 'delete'
    })
  }
  return result.changes
}

export function getRagMessages(conversationId: string): RagMessage[] {
  const db = getDB()
  return db
    .prepare(
      `
        SELECT id, uuid, conversation_id, role, content, context,
               origin_device_id, origin_device_name, created_at
        FROM rag_messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC
    `
    )
    .all(conversationId) as RagMessage[]
}

// === APP SETTINGS ===

export interface AppSettings {
  memoryStrictness?: 'lenient' | 'balanced' | 'strict'
  entityStrictness?: 'lenient' | 'balanced' | 'strict'
  [key: string]: unknown
}

export function getSettings(): AppSettings {
  const db = getDB()
  const rows = db.prepare('SELECT key, value FROM app_settings').all() as {
    key: string
    value: string
  }[]
  const settings: AppSettings = {}
  for (const row of rows) {
    try {
      settings[row.key] = JSON.parse(row.value)
    } catch {
      settings[row.key] = row.value
    }
  }
  // Set defaults if not present
  if (!settings.memoryStrictness) settings.memoryStrictness = 'balanced'
  if (!settings.entityStrictness) settings.entityStrictness = 'balanced'
  return settings
}

export function saveSetting(key: string, value: unknown): void {
  createSettingsStore(getDB()).set(key, value)
}

export function getSetting<T>(key: string, defaultValue: T): T {
  return createSettingsStore(getDB()).get(key, defaultValue)
}

export function deleteSetting(key: string): void {
  createSettingsStore(getDB()).delete(key)
}
