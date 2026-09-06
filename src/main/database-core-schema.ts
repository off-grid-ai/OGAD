import type Database from 'better-sqlite3-multiple-ciphers'
import { initializeSettingsStore } from './settings-store'

const FTS_SCHEMA_VERSION = 1

export function initializeCoreDatabaseSchema(db: Database.Database): void {
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

    -- Chat message content, searchable. The chat-list content search used to be a
    -- lower(content) LIKE match per term over rag_messages, which no index can serve: every
    -- keystroke's search read every message ever stored. External-content FTS5, same shape as
    -- message_fts above, so the index holds terms and the rows stay in rag_messages.
    CREATE VIRTUAL TABLE IF NOT EXISTS rag_message_fts USING fts5(
      content,
      conversation_id UNINDEXED,
      content='rag_messages',
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

    -- Provider-neutral Shared chat lifecycle state. Message rows remain the portable transcript;
    -- this local checkpoint makes admitted work recoverable after the renderer or app restarts.
    CREATE TABLE IF NOT EXISTS chat_session_turns (
      conversation_id TEXT PRIMARY KEY,
      turns_json TEXT NOT NULL,
      updated_at DATETIME NOT NULL,
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

    `CREATE TRIGGER IF NOT EXISTS rag_messages_ai AFTER INSERT ON rag_messages BEGIN
      INSERT INTO rag_message_fts(rowid, content, conversation_id) VALUES (new.id, new.content, new.conversation_id);
    END;`,
    `CREATE TRIGGER IF NOT EXISTS rag_messages_ad AFTER DELETE ON rag_messages BEGIN
      INSERT INTO rag_message_fts(rag_message_fts, rowid, content, conversation_id) VALUES('delete', old.id, old.content, old.conversation_id);
    END;`,
    `CREATE TRIGGER IF NOT EXISTS rag_messages_au AFTER UPDATE ON rag_messages BEGIN
      INSERT INTO rag_message_fts(rag_message_fts, rowid, content, conversation_id) VALUES('delete', old.id, old.content, old.conversation_id);
      INSERT INTO rag_message_fts(rowid, content, conversation_id) VALUES (new.id, new.content, new.conversation_id);
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

  // The search index that makes the conversation list's content search an index lookup instead of
  // a table scan, and the one that serves the list's "last message in this conversation" reads.
  // rag_messages had NO index at all: every preview and every count was a full scan.
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_rag_messages_conversation ON rag_messages(conversation_id, created_at DESC, id DESC)'
  )

  /**
   * FTS backfill, versioned so it happens once per profile instead of once per launch.
   *
   * Rebuilding five full-text indexes reads every message, summary, entity and fact in the
   * database, synchronously, on Electron's main thread. It ran on EVERY startup - so the bigger a
   * user's history got, the longer their app took to become usable, for work that had already been
   * done. `PRAGMA user_version` is the gate: bumping FTS_SCHEMA_VERSION is how a future change to
   * an FTS table or trigger repairs every existing profile exactly once.
   *
   * Nothing is trimmed or dropped here. This only rebuilds a derived index from rows that stay
   * exactly as they are.
   */
  const installedFtsVersion = Number(db.pragma('user_version', { simple: true }) ?? 0)
  if (installedFtsVersion < FTS_SCHEMA_VERSION) {
    try {
      db.exec("INSERT INTO message_fts(message_fts) VALUES('rebuild')")
      db.exec("INSERT INTO rag_message_fts(rag_message_fts) VALUES('rebuild')")
      db.exec("INSERT INTO summary_fts(summary_fts) VALUES('rebuild')")
      db.exec("INSERT INTO entity_fts(entity_fts) VALUES('rebuild')")
      db.exec("INSERT INTO entity_fact_fts(entity_fact_fts) VALUES('rebuild')")
      db.pragma(`user_version = ${FTS_SCHEMA_VERSION}`)
    } catch (error) {
      // The version is deliberately NOT advanced: a failed rebuild must be retried on the next
      // launch, not remembered as done. Search degrades to whatever the triggers have indexed.
      console.error('[database] full-text index rebuild failed; will retry next launch', error)
    }
  }
}
