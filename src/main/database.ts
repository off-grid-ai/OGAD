// better-sqlite3-multiple-ciphers is a drop-in superset of better-sqlite3 that
// adds SQLCipher-style `PRAGMA key` encryption. Same API surface + types.
import Database from 'better-sqlite3-multiple-ciphers';
import { app, safeStorage } from 'electron';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

let db: Database.Database | null = null;

// --- Encryption at rest (new DBs only) -------------------------------------
// The DB key can't live inside the DB (it gates opening it), so it's stored as a
// safeStorage-encrypted file alongside it. Policy:
//   • .dbkey present            → encrypted DB (created by us) → open with the key
//   • no .dbkey, DB file exists → legacy plaintext DB → open as-is (NO migration)
//   • neither                   → fresh install → generate a key + create encrypted
// If the OS can't provide real encryption (no Keychain), we fall back to plaintext
// so the app still works rather than refusing to open.
function loadOrCreateKey(dbPath: string): string | null {
  const keyFile = path.join(path.dirname(dbPath), '.dbkey');
  try {
    if (fs.existsSync(keyFile)) {
      const blob = fs.readFileSync(keyFile);
      return safeStorage.decryptString(blob);
    }
  } catch (e) {
    console.error('[db] failed to read DB key — opening without encryption', e);
    return null;
  }
  // No key yet. Only create one (→ encrypted DB) if there's no existing DB to
  // migrate and the OS gives us real encryption.
  if (fs.existsSync(dbPath)) return null; // legacy plaintext DB — leave it
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[db] OS encryption unavailable — creating plaintext DB');
      return null;
    }
    const key = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(keyFile, safeStorage.encryptString(key), { mode: 0o600 });
    console.log('[db] created encrypted database key');
    return key;
  } catch (e) {
    console.error('[db] failed to create DB key — creating plaintext DB', e);
    return null;
  }
}

// Cosine similarity function for vector search
// Returns similarity between 0 and 1 (1 = identical)
function cosineSimilarity(v1Str: string, v2Str: string): number {
  try {
    const v1 = JSON.parse(v1Str) as number[];
    const v2 = JSON.parse(v2Str) as number[];

    if (v1.length !== v2.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < v1.length; i++) {
        dotProduct += v1[i] * v2[i];
        normA += v1[i] * v1[i];
        normB += v2[i] * v2[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  } catch (e) {
    return 0;
  }
}

export function getDB(): Database.Database {
  if (db) return db;

  const dbPath = path.join(app.getPath('userData'), 'memories.db');
  console.log("Opening database at:", dbPath);

  const key = loadOrCreateKey(dbPath);
  db = new Database(dbPath);
  // PRAGMA key MUST run before any other access (it unlocks the file).
  if (key) {
    db.pragma(`key = '${key}'`);
    console.log('[db] opened with encryption at rest');
  }
  db.pragma('journal_mode = WAL');

  // Register custom function for vector search
  db.function('cosine_similarity', (...args: unknown[]) => cosineSimilarity(args[0] as string, args[1] as string));

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
  `);

  // Create Chat Summaries Table if not exists (migrating to conversations table eventually)
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_summaries (
      session_id TEXT PRIMARY KEY,
      summary TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Create Master Memory Table - cumulative summary of all summaries
  db.exec(`
    CREATE TABLE IF NOT EXISTS master_memory (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      content TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // User Profile Table - stores onboarding questionnaire data as JSON
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // RAG Conversations Table - stores chat sessions with the memory assistant
  db.exec(`
    CREATE TABLE IF NOT EXISTS rag_conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // RAG Messages Table - stores messages in RAG conversations
  db.exec(`
    CREATE TABLE IF NOT EXISTS rag_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      context TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(conversation_id) REFERENCES rag_conversations(id) ON DELETE CASCADE
    );
  `);

  // App Settings Table - stores application settings as key-value pairs
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

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
  ];

  for(const trigger of triggers) {
      db.exec(trigger);
  }

    try {
      db.exec("INSERT INTO message_fts(message_fts) VALUES('rebuild')");
      db.exec("INSERT INTO summary_fts(summary_fts) VALUES('rebuild')");
      db.exec("INSERT INTO entity_fts(entity_fts) VALUES('rebuild')");
      db.exec("INSERT INTO entity_fact_fts(entity_fact_fts) VALUES('rebuild')");
    } catch (e) {
      // Ignore rebuild errors
    }



  // Migration: Add timestamp column to messages if it doesn't exist
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN timestamp TEXT`);
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: Add message_id column to memories if it doesn't exist
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN message_id INTEGER`);
  } catch (e) {
    // Column already exists, ignore
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_message_id ON memories(message_id)');

  // Migration: Add name column to memories if it doesn't exist
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN name TEXT`);
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: Add project_id to rag_conversations (chats can be scoped to a project)
  try {
    db.exec(`ALTER TABLE rag_conversations ADD COLUMN project_id TEXT`);
  } catch (e) {
    // Column already exists, ignore
  }

  return db;
}

/** Run an idempotent schema migration (CREATE TABLE IF NOT EXISTS …) on the
 *  shared DB. Exposed so the pro package can create its own tables (observations,
 *  entities, approvals, …) without core knowing about them. */
export function runMigration(sql: string): void {
  getDB().exec(sql);
}

// === NEW API ACCESSORS ===

export function getChatSessions(appName?: string) {
    const db = getDB();
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
    `;
    
    if (appName && appName !== 'All') {
        query += ` WHERE c.app_name LIKE ? `;
    }
    
    query += ` ORDER BY c.updated_at DESC`;

    const stmt = db.prepare(query);
    if (appName && appName !== 'All') {
        return stmt.all(`%${appName}%`);
    } else {
        return stmt.all();
    }
}

export function upsertChatSummary(sessionId: string, summary: string) {
    const db = getDB();
    const stmt = db.prepare(`
        INSERT INTO chat_summaries (session_id, summary, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(session_id) DO UPDATE SET
            summary = excluded.summary,
            updated_at = excluded.updated_at
    `);
    stmt.run(sessionId, summary);
}

export function getMemoriesForSession(sessionId: string, limit: number = 200) {
    const db = getDB();
    // Fetch from new 'messages' table
    const stmt = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?');
    const messages = stmt.all(sessionId, limit);
    
    // Map to old Memory interface shape if needed by UI, or UI updates? 
    // UI expects { id, content, raw_text, source_app, created_at, role? }
    // We added 'role' to messages.
    return messages;
}

  export function getMemoryRecordsForSession(sessionId: string, limit: number = 200) {
    const db = getDB();
    const stmt = db.prepare('SELECT * FROM memories WHERE session_id = ? ORDER BY created_at ASC LIMIT ?');
    return stmt.all(sessionId, limit);
  }

export function checkMessageExists(hash: string, conversationId: string): boolean {
    const db = getDB();
    const stmt = db.prepare('SELECT id FROM messages WHERE conversation_id = ? AND hash = ? LIMIT 1');
    const result = stmt.get(conversationId, hash);
    return !!result;
}

// Deprecated: old check
export function checkMemoryExists(_content: string, _sessionId: string): boolean {
    // Forward to new check logic if we want, or keep it for legacy?
    // We will use checkMessageExists for new flow.
    return false; 
}

// === MASTER MEMORY ===

export function getMasterMemory(): { content: string | null; updated_at: string | null } {
    const db = getDB();
    const result = db.prepare('SELECT content, updated_at FROM master_memory WHERE id = 1').get() as { content: string; updated_at: string } | undefined;
    return result || { content: null, updated_at: null };
}

export function updateMasterMemory(content: string) {
    const db = getDB();
    const stmt = db.prepare(`
        INSERT INTO master_memory (id, content, updated_at)
        VALUES (1, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
            content = excluded.content,
            updated_at = excluded.updated_at
    `);
    stmt.run(content);
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
    const db = getDB();
    const legacy = db.prepare(`
        SELECT id FROM conversations
        WHERE app_name IN ('Claude.ai','ChatGPT','Gemini')
           OR LOWER(app_name) LIKE '%claude%'
           OR LOWER(app_name) LIKE '%chatgpt%'
           OR LOWER(app_name) LIKE '%gemini%'
    `).all() as { id: string }[];
    const ids = legacy.map((r) => r.id);
    if (ids.length === 0) return null;

    const ph = ids.map(() => '?').join(',');
    const hasObsEntities = !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='observation_entities'`).get();

    const run = db.transaction(() => {
        const counts: Record<string, number> = {};
        const messages = db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE conversation_id IN (${ph})`).get(...ids) as { c: number };
        counts.messages = messages.c;
        counts.memories = db.prepare(`DELETE FROM memories WHERE session_id IN (${ph})`).run(...ids).changes;
        counts.summaries = db.prepare(`DELETE FROM chat_summaries WHERE session_id IN (${ph})`).run(...ids).changes;
        counts.entityFacts = db.prepare(`DELETE FROM entity_facts WHERE source_session_id IN (${ph})`).run(...ids).changes;
        // Cascades messages + entity_sessions (both FK conversations ON DELETE CASCADE).
        counts.conversations = db.prepare(`DELETE FROM conversations WHERE id IN (${ph})`).run(...ids).changes;
        // Drop entities now orphaned across every link table (keeps current-capture entities).
        const orphanGuard = hasObsEntities
            ? `id NOT IN (SELECT entity_id FROM entity_sessions)
               AND id NOT IN (SELECT entity_id FROM entity_facts)
               AND id NOT IN (SELECT entity_id FROM observation_entities)`
            : `id NOT IN (SELECT entity_id FROM entity_sessions)
               AND id NOT IN (SELECT entity_id FROM entity_facts)`;
        counts.entitiesDeleted = hasObsEntities
            ? db.prepare(`DELETE FROM entities WHERE ${orphanGuard}`).run().changes
            : 0; // without obs links we can't tell current from legacy — leave them
        // The stale consolidated profile is gone for good.
        counts.masterMemory = db.prepare(`DELETE FROM master_memory`).run().changes;
        // Rebuild external-content FTS indexes so they don't point at deleted rows.
        for (const t of ['memory_fts', 'message_fts', 'summary_fts', 'entity_fts', 'entity_fact_fts']) {
            try { db.prepare(`INSERT INTO ${t}(${t}) VALUES('rebuild')`).run(); } catch { /* table may be absent */ }
        }
        return counts;
    });
    const result = run();
    console.log('[DB] Purged legacy My Memories chat imports:', result);
    return result;
}

export function getAllChatSummaries(): { session_id: string; summary: string }[] {
    const db = getDB();
    const stmt = db.prepare('SELECT session_id, summary FROM chat_summaries WHERE summary IS NOT NULL');
    return stmt.all() as { session_id: string; summary: string }[];
}

// === ENTITIES ===

export function upsertEntity(name: string, type: string = 'Unknown'): number {
    const db = getDB();
    const stmt = db.prepare(`
      INSERT INTO entities (name, type, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(name, type) DO UPDATE SET updated_at = excluded.updated_at
    `);
    stmt.run(name.trim(), type.trim() || 'Unknown');

    const row = db.prepare('SELECT id FROM entities WHERE name = ? AND type = ?').get(name.trim(), type.trim() || 'Unknown') as { id: number } | undefined;
    return row?.id || 0;
}

export function updateEntitySummary(entityId: number, summary: string) {
    const db = getDB();
    const stmt = db.prepare(`
      UPDATE entities SET summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `);
    stmt.run(summary, entityId);
}

export function addEntityFact(entityId: number, fact: string, sessionId?: string): boolean {
    const db = getDB();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO entity_facts (entity_id, fact, source_session_id)
      VALUES (?, ?, ?)
    `);
    const info = stmt.run(entityId, fact.trim(), sessionId || null);
    return info.changes > 0;
}

export function upsertEntitySession(entityId: number, sessionId: string): void {
    const db = getDB();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO entity_sessions (entity_id, session_id)
      VALUES (?, ?)
    `);
    stmt.run(entityId, sessionId);
}

function normalizeEdgePair(a: number, b: number): [number, number] {
    return a < b ? [a, b] : [b, a];
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function rebuildEntityEdgesForSession(sessionId: string): void {
    const db = getDB();
    const entities = db.prepare(`
      SELECT entity_id FROM entity_sessions WHERE session_id = ?
    `).all(sessionId) as { entity_id: number }[];

    const entityIds = entities.map(e => e.entity_id).filter(Boolean);
    if (entityIds.length < 2) return;

    const upsertEdge = db.prepare(`
      INSERT INTO entity_edges (source_entity_id, target_entity_id, type, weight, evidence_count, last_session_id, updated_at)
      VALUES (?, ?, 'cooccurrence', 1, 1, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(source_entity_id, target_entity_id, type) DO UPDATE SET
        weight = entity_edges.weight + 1,
        evidence_count = entity_edges.evidence_count + 1,
        last_session_id = excluded.last_session_id,
        updated_at = excluded.updated_at
    `);

    for (let i = 0; i < entityIds.length; i++) {
        for (let j = i + 1; j < entityIds.length; j++) {
            const [sourceId, targetId] = normalizeEdgePair(entityIds[i], entityIds[j]);
            upsertEdge.run(sourceId, targetId, sessionId);
        }
    }
}

  function rebuildEntityEdgesFromMentions(): void {
    const db = getDB();
    const entities = db.prepare(`
      SELECT id, name, summary FROM entities
    `).all() as { id: number; name: string; summary: string | null }[];

    if (entities.length < 2) return;

    const matchers = entities.map(e => ({
      id: e.id,
      name: e.name,
      regex: new RegExp(`\\b${escapeRegExp(e.name)}\\b`, 'i')
    }));

    const upsertMention = db.prepare(`
      INSERT INTO entity_edges (source_entity_id, target_entity_id, type, weight, evidence_count, last_session_id, updated_at)
      VALUES (?, ?, 'mention', 1, 1, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(source_entity_id, target_entity_id, type) DO UPDATE SET
      weight = entity_edges.weight + 1,
      evidence_count = entity_edges.evidence_count + 1,
      last_session_id = COALESCE(excluded.last_session_id, entity_edges.last_session_id),
      updated_at = excluded.updated_at
    `);

    const facts = db.prepare(`
      SELECT entity_id, fact, source_session_id FROM entity_facts
    `).all() as { entity_id: number; fact: string; source_session_id: string | null }[];

    for (const factRow of facts) {
      const text = factRow.fact || '';
      if (!text) continue;
      for (const matcher of matchers) {
        if (matcher.id === factRow.entity_id) continue;
        if (matcher.regex.test(text)) {
          const [sourceId, targetId] = normalizeEdgePair(factRow.entity_id, matcher.id);
          upsertMention.run(sourceId, targetId, factRow.source_session_id || null);
        }
      }
    }

    for (const entity of entities) {
      const text = entity.summary || '';
      if (!text) continue;
      for (const matcher of matchers) {
        if (matcher.id === entity.id) continue;
        if (matcher.regex.test(text)) {
          const [sourceId, targetId] = normalizeEdgePair(entity.id, matcher.id);
          upsertMention.run(sourceId, targetId, null);
        }
      }
    }
  }

  export function rebuildEntityEdgesForAllSessions(): void {
    const db = getDB();
    db.prepare(`
      INSERT OR IGNORE INTO entity_sessions (entity_id, session_id)
      SELECT entity_id, source_session_id
      FROM entity_facts
      WHERE source_session_id IS NOT NULL
    `).run();

    db.prepare('DELETE FROM entity_edges').run();

    const sessions = db.prepare('SELECT DISTINCT session_id FROM entity_sessions').all() as { session_id: string }[];
    for (const row of sessions) {
      rebuildEntityEdgesForSession(row.session_id);
    }

    rebuildEntityEdgesFromMentions();
  }

export function getEntities(appName?: string) {
    const db = getDB();
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
    `;

    const params: any[] = [];
    if (appName && appName !== 'All') {
        query += ` WHERE c.app_name LIKE ? `;
        params.push(`%${appName}%`);
    }

    query += ` GROUP BY e.id ORDER BY e.updated_at DESC`;
    const stmt = db.prepare(query);
    return stmt.all(...params);
}

export function getEntityDetails(entityId: number, appName?: string) {
    const db = getDB();
    const entity = db.prepare('SELECT * FROM entities WHERE id = ?').get(entityId);

    let factsQuery = `
      SELECT f.id, f.fact, f.source_session_id, f.created_at
      FROM entity_facts f
      LEFT JOIN conversations c ON f.source_session_id = c.id
      WHERE f.entity_id = ?
    `;
    const params: any[] = [entityId];
    if (appName && appName !== 'All') {
        factsQuery += ` AND c.app_name LIKE ? `;
        params.push(`%${appName}%`);
    }
    factsQuery += ` ORDER BY f.created_at DESC`;

    const facts = db.prepare(factsQuery).all(...params);
    return { entity, facts };
}

export function getEntitiesForSession(sessionId: string) {
    const db = getDB();
    const stmt = db.prepare(`
      SELECT e.id, e.name, e.type, e.summary, e.updated_at,
             COUNT(DISTINCT f.id) as fact_count
      FROM entities e
      JOIN entity_sessions es ON es.entity_id = e.id
      LEFT JOIN entity_facts f ON f.entity_id = e.id
      WHERE es.session_id = ?
      GROUP BY e.id
      ORDER BY e.updated_at DESC
    `);
    return stmt.all(sessionId);
}

  export function getEntityGraph(appName?: string, focusEntityId?: number, edgeLimit: number = 200, factsPerNode: number = 3) {
    const db = getDB();

    let allowedEntityIds: number[] | null = null;
    if (appName && appName !== 'All') {
      const rows = db.prepare(`
        SELECT DISTINCT es.entity_id
        FROM entity_sessions es
        JOIN conversations c ON es.session_id = c.id
        WHERE c.app_name LIKE ?
      `).all(`%${appName}%`) as { entity_id: number }[];
      allowedEntityIds = rows.map(r => r.entity_id);
      if (allowedEntityIds.length === 0) {
        return { nodes: [], edges: [] };
      }
    }

    const edgeParams: any[] = [];
    let edgeQuery = `
      SELECT source_entity_id as source, target_entity_id as target, type, weight, evidence_count, updated_at
      FROM entity_edges
    `;

    const whereClauses: string[] = [];
    if (typeof focusEntityId === 'number') {
      whereClauses.push('(source_entity_id = ? OR target_entity_id = ?)');
      edgeParams.push(focusEntityId, focusEntityId);
    }

    if (allowedEntityIds) {
      const placeholders = allowedEntityIds.map(() => '?').join(',');
      whereClauses.push(`source_entity_id IN (${placeholders})`);
      whereClauses.push(`target_entity_id IN (${placeholders})`);
      edgeParams.push(...allowedEntityIds, ...allowedEntityIds);
    }

    if (whereClauses.length > 0) {
      edgeQuery += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    edgeQuery += ` ORDER BY weight DESC LIMIT ?`;
    edgeParams.push(edgeLimit);

    const edges = db.prepare(edgeQuery).all(...edgeParams) as {
      source: number;
      target: number;
      type: string;
      weight: number;
      evidence_count: number;
      updated_at: string;
    }[];

    if (edges.length === 0 && typeof focusEntityId !== 'number') {
      let nodeQuery = `
        SELECT e.id, e.name, e.type, e.summary, e.updated_at,
           COUNT(DISTINCT f.id) as fact_count,
           COUNT(DISTINCT es.session_id) as session_count
        FROM entities e
        LEFT JOIN entity_facts f ON f.entity_id = e.id
        LEFT JOIN entity_sessions es ON es.entity_id = e.id
      `;
      const nodeParams: any[] = [];
      if (allowedEntityIds) {
        const placeholders = allowedEntityIds.map(() => '?').join(',');
        nodeQuery += ` WHERE e.id IN (${placeholders}) `;
        nodeParams.push(...allowedEntityIds);
      }
      nodeQuery += ` GROUP BY e.id ORDER BY e.updated_at DESC LIMIT 50`;

      const nodes = db.prepare(nodeQuery).all(...nodeParams) as {
        id: number;
        name: string;
        type: string;
        summary: string | null;
        updated_at: string;
        fact_count: number;
        session_count: number;
      }[];

      const nodeIds = nodes.map(n => n.id);
      if (nodeIds.length === 0) return { nodes: [], edges: [] };

      const nodePlaceholders = nodeIds.map(() => '?').join(',');
      const facts = db.prepare(`
        SELECT entity_id, fact, created_at
        FROM entity_facts
        WHERE entity_id IN (${nodePlaceholders})
        ORDER BY created_at DESC
      `).all(...nodeIds) as { entity_id: number; fact: string; created_at: string }[];

      const factsByEntity = new Map<number, string[]>();
      for (const row of facts) {
        const list = factsByEntity.get(row.entity_id) || [];
        if (list.length < factsPerNode) {
          list.push(row.fact);
          factsByEntity.set(row.entity_id, list);
        }
      }

      const nodesWithFacts = nodes.map(n => ({
        ...n,
        facts: factsByEntity.get(n.id) || []
      }));

      return { nodes: nodesWithFacts, edges: [] };
    }

    const nodeIdSet = new Set<number>();
    edges.forEach(e => {
      nodeIdSet.add(e.source);
      nodeIdSet.add(e.target);
    });
    if (typeof focusEntityId === 'number') nodeIdSet.add(focusEntityId);

    const nodeIds = Array.from(nodeIdSet);
    if (nodeIds.length === 0) {
      return { nodes: [], edges: [] };
    }

    const nodePlaceholders = nodeIds.map(() => '?').join(',');
    const nodes = db.prepare(`
      SELECT e.id, e.name, e.type, e.summary, e.updated_at,
         COUNT(DISTINCT f.id) as fact_count,
         COUNT(DISTINCT es.session_id) as session_count
      FROM entities e
      LEFT JOIN entity_facts f ON f.entity_id = e.id
      LEFT JOIN entity_sessions es ON es.entity_id = e.id
      WHERE e.id IN (${nodePlaceholders})
      GROUP BY e.id
    `).all(...nodeIds) as {
      id: number;
      name: string;
      type: string;
      summary: string | null;
      updated_at: string;
      fact_count: number;
      session_count: number;
    }[];

    const facts = db.prepare(`
      SELECT entity_id, fact, created_at
      FROM entity_facts
      WHERE entity_id IN (${nodePlaceholders})
      ORDER BY created_at DESC
    `).all(...nodeIds) as { entity_id: number; fact: string; created_at: string }[];

    const factsByEntity = new Map<number, string[]>();
    for (const row of facts) {
      const list = factsByEntity.get(row.entity_id) || [];
      if (list.length < factsPerNode) {
        list.push(row.fact);
        factsByEntity.set(row.entity_id, list);
      }
    }

    const nodesWithFacts = nodes.map(n => ({
      ...n,
      facts: factsByEntity.get(n.id) || []
    }));

    return { nodes: nodesWithFacts, edges };
  }

// === DELETE FUNCTIONS ===

export function deleteEntity(entityId: number): boolean {
    const db = getDB();
    // Foreign key cascade will handle entity_facts, entity_sessions, entity_edges
    const stmt = db.prepare('DELETE FROM entities WHERE id = ?');
    const info = stmt.run(entityId);
    console.log(`Deleted entity ${entityId}, changes: ${info.changes}`);
    return info.changes > 0;
}

export function deleteMemory(memoryId: number): boolean {
    const db = getDB();
    const stmt = db.prepare('DELETE FROM memories WHERE id = ?');
    const info = stmt.run(memoryId);
    console.log(`Deleted memory ${memoryId}, changes: ${info.changes}`);
    return info.changes > 0;
}

// === DASHBOARD STATS ===

export interface DashboardStats {
    totalChats: number;
    totalMemories: number;
    totalEntities: number;
    totalRelationships: number;
    totalMessages: number;
    todayChats: number;
    todayMemories: number;
    todayEntities: number;
    totalFacts: number;
    recentChats: Array<{
        session_id: string;
        title: string | null;
        app_name: string;
        memory_count: number;
        entity_count: number;
        updated_at: string;
    }>;
    recentMemories: Array<{
        id: number;
        content: string;
        source_app: string;
        created_at: string;
    }>;
    topEntities: Array<{
        id: number;
        name: string;
        type: string;
        fact_count: number;
        session_count: number;
    }>;
    entityTypeCounts: Array<{
        type: string;
        count: number;
    }>;
    appDistribution: Array<{
        app_name: string;
        chat_count: number;
        memory_count: number;
    }>;
    activityByDay: Array<{
        date: string;
        chats: number;
        memories: number;
    }>;
}

export function getDashboardStats(): DashboardStats {
    const db = getDB();

    // Total counts
    const totalChats = (db.prepare('SELECT COUNT(*) as count FROM conversations').get() as { count: number }).count;
    const totalMemories = (db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number }).count;
    const totalEntities = (db.prepare('SELECT COUNT(*) as count FROM entities').get() as { count: number }).count;
    const totalRelationships = (db.prepare('SELECT COUNT(*) as count FROM entity_edges').get() as { count: number }).count;
    const totalMessages = (db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number }).count;
    const totalFacts = (db.prepare('SELECT COUNT(*) as count FROM entity_facts').get() as { count: number }).count;

    // Today's activity (convert stored timestamps to localtime before comparing)
    const todayChats = (db.prepare(`SELECT COUNT(*) as count FROM conversations WHERE date(updated_at, 'localtime') = date('now', 'localtime')`).get() as { count: number }).count;
    const todayMemories = (db.prepare(`SELECT COUNT(*) as count FROM memories WHERE date(created_at, 'localtime') = date('now', 'localtime')`).get() as { count: number }).count;
    const todayEntities = (db.prepare(`SELECT COUNT(*) as count FROM entities WHERE date(created_at, 'localtime') = date('now', 'localtime')`).get() as { count: number }).count;

    // Recent chats (top 5)
    const recentChats = db.prepare(`
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
    `).all() as DashboardStats['recentChats'];

    // Recent memories (top 5)
    const recentMemories = db.prepare(`
        SELECT id, content, source_app, created_at
        FROM memories
        ORDER BY created_at DESC
        LIMIT 5
    `).all() as DashboardStats['recentMemories'];

    // Top entities by fact count
    const topEntities = db.prepare(`
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
    `).all() as DashboardStats['topEntities'];

    // Entity type distribution
    const entityTypeCounts = db.prepare(`
        SELECT type, COUNT(*) as count
        FROM entities
        GROUP BY type
        ORDER BY count DESC
        LIMIT 8
    `).all() as DashboardStats['entityTypeCounts'];

    // App distribution
    const appDistribution = db.prepare(`
        SELECT 
            COALESCE(c.app_name, 'Unknown') as app_name,
            COUNT(DISTINCT c.id) as chat_count,
            COUNT(DISTINCT m.id) as memory_count
        FROM conversations c
        LEFT JOIN memories m ON m.session_id = c.id
        GROUP BY c.app_name
        ORDER BY chat_count DESC
    `).all() as DashboardStats['appDistribution'];

    // Activity by day (last 14 days, using localtime)
    const activityByDay = db.prepare(`
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
    `).all() as DashboardStats['activityByDay'];

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
        activityByDay,
    };
}

// === USER PROFILE ===

export interface UserProfile {
    role?: string;
    companySize?: string;
    aiUsageFrequency?: string;
    primaryTools?: string[];
    painPoints?: string[];
    primaryUseCase?: string;
    privacyConcern?: string;
    expectedBenefit?: string;
    referralSource?: string;
    completedAt?: string;
}

export function getUserProfile(): UserProfile | null {
    const db = getDB();
    const row = db.prepare('SELECT data FROM user_profile WHERE id = 1').get() as { data: string } | undefined;
    if (!row) return null;
    try {
        return JSON.parse(row.data) as UserProfile;
    } catch {
        return null;
    }
}

export function saveUserProfile(profile: UserProfile): void {
    const db = getDB();
    const now = new Date().toISOString();
    const dataWithTimestamp = { ...profile, completedAt: now };
    const json = JSON.stringify(dataWithTimestamp);
    
    db.prepare(`
        INSERT INTO user_profile (id, data, updated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = ?, updated_at = ?
    `).run(json, now, json, now);
}

// === RAG CONVERSATIONS ===

export interface RagConversation {
    id: string;
    title: string | null;
    project_id?: string | null;
    created_at: string;
    updated_at: string;
    message_count?: number;
}

export interface RagMessage {
    id: number;
    conversation_id: string;
    role: 'user' | 'assistant';
    content: string;
    context: string | null;
    created_at: string;
}

export function createRagConversation(id: string, title?: string, projectId?: string | null): string {
    const db = getDB();
    db.prepare(`
        INSERT INTO rag_conversations (id, title, project_id, created_at, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(id, title || null, projectId || null);
    return id;
}

export function getRagConversations(projectId?: string | null): RagConversation[] {
    const db = getDB();
    const where = projectId === undefined ? '' : projectId === null ? 'WHERE rc.project_id IS NULL' : 'WHERE rc.project_id = ?';
    const stmt = db.prepare(`
        SELECT
            rc.id,
            rc.title,
            rc.project_id,
            rc.created_at,
            rc.updated_at,
            (SELECT COUNT(*) FROM rag_messages rm WHERE rm.conversation_id = rc.id) as message_count
        FROM rag_conversations rc
        ${where}
        ORDER BY rc.updated_at DESC
    `);
    return (projectId ? stmt.all(projectId) : stmt.all()) as RagConversation[];
}

export function getRagConversation(id: string): RagConversation | null {
    const db = getDB();
    return db.prepare(`
        SELECT id, title, project_id, created_at, updated_at
        FROM rag_conversations
        WHERE id = ?
    `).get(id) as RagConversation | null;
}

export function setRagConversationProject(id: string, projectId: string | null): void {
    const db = getDB();
    db.prepare(`UPDATE rag_conversations SET project_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(projectId, id);
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
    const db = getDB();
    // Project memory spans EVERY sibling chat in the project, regardless of which
    // path stored it — rag_messages (main chat) and project_messages (project
    // threads). UNION both so context isn't lost across chats in the project.
    const rows = db.prepare(`
        SELECT role, content, title, created_at FROM (
            SELECT rm.role AS role, rm.content AS content, rc.title AS title, rm.created_at AS created_at
            FROM rag_messages rm
            JOIN rag_conversations rc ON rc.id = rm.conversation_id
            WHERE rc.project_id = ? AND rm.conversation_id != ?
            UNION ALL
            SELECT pm.role AS role, pm.content AS content, pt.title AS title, pm.created_at AS created_at
            FROM project_messages pm
            JOIN project_threads pt ON pt.id = pm.thread_id
            WHERE pt.project_id = ? AND pm.thread_id != ?
        )
        ORDER BY created_at DESC
        LIMIT ?
    `).all(projectId, excludeConversationId, projectId, excludeConversationId, limit) as { role: string; content: string; title: string | null; created_at: string }[];
    return rows.map(({ role, content, title }) => ({ role, content, title })).reverse();
}

export function updateRagConversationTitle(id: string, title: string): void {
    const db = getDB();
    db.prepare(`
        UPDATE rag_conversations 
        SET title = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
    `).run(title, id);
}

export function deleteRagConversation(id: string): boolean {
    const db = getDB();
    const info = db.prepare('DELETE FROM rag_conversations WHERE id = ?').run(id);
    return info.changes > 0;
}

export function addRagMessage(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    context?: any
): number {
    const db = getDB();
    const contextJson = context ? JSON.stringify(context) : null;
    
    const info = db.prepare(`
        INSERT INTO rag_messages (conversation_id, role, content, context, created_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(conversationId, role, content, contextJson);
    
    // Update conversation updated_at timestamp
    db.prepare(`
        UPDATE rag_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(conversationId);
    
    return Number(info.lastInsertRowid);
}

// Keep the first `keepCount` messages of a conversation (chronological) and
// delete the rest — used by regenerate/edit so old answers don't pile up.
export function truncateRagMessages(conversationId: string, keepCount: number): number {
    const db = getDB();
    const rows = db.prepare(`SELECT id FROM rag_messages WHERE conversation_id = ? ORDER BY id ASC`).all(conversationId) as { id: number }[];
    const toDelete = rows.slice(Math.max(0, keepCount)).map((r) => r.id);
    if (!toDelete.length) return 0;
    const ph = toDelete.map(() => '?').join(',');
    return db.prepare(`DELETE FROM rag_messages WHERE id IN (${ph})`).run(...toDelete).changes;
}

export function getRagMessages(conversationId: string): RagMessage[] {
    const db = getDB();
    return db.prepare(`
        SELECT id, conversation_id, role, content, context, created_at
        FROM rag_messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC
    `).all(conversationId) as RagMessage[];
}

// === APP SETTINGS ===

export interface AppSettings {
    memoryStrictness?: 'lenient' | 'balanced' | 'strict';
    entityStrictness?: 'lenient' | 'balanced' | 'strict';
    [key: string]: any;
}

export function getSettings(): AppSettings {
    const db = getDB();
    const rows = db.prepare('SELECT key, value FROM app_settings').all() as { key: string; value: string }[];
    const settings: AppSettings = {};
    for (const row of rows) {
        try {
            settings[row.key] = JSON.parse(row.value);
        } catch {
            settings[row.key] = row.value;
        }
    }
    // Set defaults if not present
    if (!settings.memoryStrictness) settings.memoryStrictness = 'balanced';
    if (!settings.entityStrictness) settings.entityStrictness = 'balanced';
    return settings;
}

export function saveSetting(key: string, value: any): void {
    const db = getDB();
    const valueJson = JSON.stringify(value);
    db.prepare(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
    `).run(key, valueJson, valueJson);
}

export function getSetting<T>(key: string, defaultValue: T): T {
    const db = getDB();
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return defaultValue;
    try {
        return JSON.parse(row.value) as T;
    } catch {
        return defaultValue;
    }
}

export function deleteSetting(key: string): void {
    const db = getDB();
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
}

