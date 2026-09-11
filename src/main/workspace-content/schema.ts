import type Database from 'better-sqlite3-multiple-ciphers'

export const WORKSPACE_CONTENT_SCHEMA_VERSION = 1

const MESSAGE_CONTENT_COLUMNS = `
    content TEXT,
    content_json TEXT CHECK (
      content_json IS NULL OR (json_valid(content_json) AND json_type(content_json) = 'array')
    ),`

const MESSAGE_CONTENT_INVARIANT = `CHECK ((content IS NULL) <> (content_json IS NULL))`

const WORKSPACE_CONTENT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS workspace_content_projects (
    id TEXT NOT NULL PRIMARY KEY CHECK (trim(id) <> ''),
    sync_operation_id TEXT NOT NULL CHECK (trim(sync_operation_id) <> ''),
    name TEXT NOT NULL CHECK (trim(name) <> ''),
    description TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    icon TEXT,
    include_memory INTEGER NOT NULL DEFAULT 1 CHECK (include_memory IN (0, 1)),
    created_at TEXT NOT NULL CHECK (trim(created_at) <> ''),
    updated_at TEXT NOT NULL CHECK (trim(updated_at) <> '')
  );

  CREATE TABLE IF NOT EXISTS workspace_content_conversations (
    id TEXT NOT NULL PRIMARY KEY CHECK (trim(id) <> ''),
    title TEXT NOT NULL DEFAULT '',
    model_id TEXT,
    project_id TEXT,
    compaction_summary TEXT,
    compaction_cutoff_message_id TEXT,
    created_at TEXT NOT NULL CHECK (trim(created_at) <> ''),
    updated_at TEXT NOT NULL CHECK (trim(updated_at) <> ''),
    FOREIGN KEY (project_id) REFERENCES workspace_content_projects(id)
      ON UPDATE CASCADE ON DELETE SET NULL,
    FOREIGN KEY (compaction_cutoff_message_id) REFERENCES workspace_content_messages(id)
      ON UPDATE CASCADE ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS workspace_content_messages (
    id TEXT NOT NULL PRIMARY KEY CHECK (trim(id) <> ''),
    conversation_id TEXT NOT NULL,
    turn_id TEXT,
    position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
    role TEXT NOT NULL CHECK (trim(role) <> ''),
    ${MESSAGE_CONTENT_COLUMNS}
    context_json TEXT CHECK (context_json IS NULL OR json_valid(context_json)),
    legacy_order_created_at TEXT,
    order_token_json TEXT CHECK (order_token_json IS NULL OR json_valid(order_token_json)),
    created_at TEXT NOT NULL CHECK (trim(created_at) <> ''),
    updated_at TEXT NOT NULL CHECK (trim(updated_at) <> ''),
    ${MESSAGE_CONTENT_INVARIANT},
    FOREIGN KEY (conversation_id) REFERENCES workspace_content_conversations(id)
      ON UPDATE CASCADE ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS workspace_content_chat_turns (
    conversation_id TEXT NOT NULL PRIMARY KEY,
    turns_json TEXT NOT NULL CHECK (json_valid(turns_json) AND json_type(turns_json) = 'array'),
    updated_at TEXT NOT NULL CHECK (trim(updated_at) <> ''),
    FOREIGN KEY (conversation_id) REFERENCES workspace_content_conversations(id)
      ON UPDATE CASCADE ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS workspace_content_local_message_state (
    message_id TEXT NOT NULL PRIMARY KEY,
    state_json TEXT NOT NULL CHECK (json_valid(state_json) AND json_type(state_json) = 'object'),
    FOREIGN KEY (message_id) REFERENCES workspace_content_messages(id)
      ON UPDATE CASCADE ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS workspace_content_migration_journal (
    target_version INTEGER PRIMARY KEY CHECK (target_version > 0),
    status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
    started_at TEXT NOT NULL CHECK (trim(started_at) <> ''),
    finished_at TEXT,
    failure_message TEXT,
    CHECK (
      (status = 'started' AND finished_at IS NULL AND failure_message IS NULL)
      OR (status = 'completed' AND finished_at IS NOT NULL AND trim(finished_at) <> '' AND failure_message IS NULL)
      OR (
        status = 'failed'
        AND finished_at IS NOT NULL
        AND trim(finished_at) <> ''
        AND failure_message IS NOT NULL
        AND trim(failure_message) <> ''
      )
    )
  );

  CREATE TABLE IF NOT EXISTS workspace_content_outbox (
    id TEXT NOT NULL PRIMARY KEY CHECK (trim(id) <> ''),
    transaction_id TEXT NOT NULL CHECK (trim(transaction_id) <> ''),
    transaction_order INTEGER NOT NULL CHECK (transaction_order >= 0),
    entity_type TEXT NOT NULL CHECK (entity_type IN ('project', 'conversation', 'message', 'chat_turns')),
    entity_id TEXT NOT NULL CHECK (trim(entity_id) <> ''),
    operation TEXT NOT NULL CHECK (operation IN ('put', 'delete')),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL CHECK (trim(created_at) <> ''),
    delivered_at TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error TEXT,
    UNIQUE (transaction_id, transaction_order)
  );

  -- Single-row durable counter for the repository's optimistic-concurrency token. Kept independent
  -- of the outbox table: a remote commit skips the outbox insert (no echo), but must still advance
  -- the revision, or every subsequent commit would keep racing against a stale expectedRevision.
  CREATE TABLE IF NOT EXISTS workspace_content_revision (
    id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
    revision TEXT NOT NULL CHECK (trim(revision) <> '')
  );

  CREATE TABLE IF NOT EXISTS workspace_content_project_deletion_intents (
    project_id TEXT NOT NULL PRIMARY KEY CHECK (trim(project_id) <> ''),
    origin TEXT NOT NULL DEFAULT 'local' CHECK (origin IN ('local', 'remote')),
    remote_operation_id TEXT,
    state TEXT NOT NULL,
    phase TEXT NOT NULL,
    remaining_document_sync_ids_json TEXT NOT NULL CHECK (
      json_valid(remaining_document_sync_ids_json)
      AND json_type(remaining_document_sync_ids_json) = 'array'
    ),
    attempt INTEGER NOT NULL CHECK (attempt >= 0),
    updated_at TEXT NOT NULL CHECK (trim(updated_at) <> ''),
    last_failure TEXT,
    -- Stable generated-image identities captured by the media phase BEFORE the Workspace Content
    -- project row is deleted. NULL means the phase has not captured them yet; an empty array means
    -- the phase captured nothing to remove. Owned by the media cleanup, not by the Shared intent.
    pending_generated_image_ids_json TEXT CHECK (
      pending_generated_image_ids_json IS NULL
      OR (json_valid(pending_generated_image_ids_json)
          AND json_type(pending_generated_image_ids_json) = 'array')
    )
  );

  CREATE TABLE IF NOT EXISTS workspace_content_conversation_deletion_intents (
    conversation_id TEXT NOT NULL PRIMARY KEY CHECK (trim(conversation_id) <> ''),
    origin TEXT NOT NULL DEFAULT 'local' CHECK (origin IN ('local', 'remote')),
    remote_operation_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'failed', 'completed')),
    phase TEXT NOT NULL CHECK (
      phase IN ('workspace_content', 'generated_images', 'image_bytes', 'completed')
    ),
    image_ids_json TEXT NOT NULL CHECK (
      json_valid(image_ids_json) AND json_type(image_ids_json) = 'array'
    ),
    attempt INTEGER NOT NULL CHECK (attempt >= 0),
    updated_at TEXT NOT NULL CHECK (trim(updated_at) <> ''),
    last_failure TEXT
  );

  CREATE INDEX IF NOT EXISTS workspace_content_projects_order
    ON workspace_content_projects(updated_at DESC, id ASC);
  CREATE INDEX IF NOT EXISTS workspace_content_conversations_order
    ON workspace_content_conversations(updated_at DESC, id ASC);
  CREATE INDEX IF NOT EXISTS workspace_content_messages_order
    ON workspace_content_messages(conversation_id, created_at ASC, id ASC);
  CREATE INDEX IF NOT EXISTS workspace_content_messages_position_order
    ON workspace_content_messages(conversation_id, position ASC, id ASC);
  CREATE INDEX IF NOT EXISTS workspace_content_outbox_pending_order
    ON workspace_content_outbox(delivered_at, created_at ASC, id ASC);
  CREATE INDEX IF NOT EXISTS workspace_content_project_deletion_pending
    ON workspace_content_project_deletion_intents(state, updated_at, project_id);
  CREATE INDEX IF NOT EXISTS workspace_content_conversation_deletion_pending
    ON workspace_content_conversation_deletion_intents(state, updated_at, conversation_id);

`

function hasRichContentColumn(db: Database.Database): boolean {
  return (db.pragma('table_info(workspace_content_messages)') as Array<{ name: string }>).some(
    (column) => column.name === 'content_json'
  )
}

function upgradeMessageContent(db: Database.Database): void {
  if (hasRichContentColumn(db)) return
  db.pragma('foreign_keys = OFF')
  db.pragma('legacy_alter_table = ON')
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE workspace_content_messages_rich (
          id TEXT NOT NULL PRIMARY KEY CHECK (trim(id) <> ''),
          conversation_id TEXT NOT NULL,
          turn_id TEXT,
          position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
          role TEXT NOT NULL CHECK (trim(role) <> ''),
          ${MESSAGE_CONTENT_COLUMNS}
          context_json TEXT CHECK (context_json IS NULL OR json_valid(context_json)),
          legacy_order_created_at TEXT,
          created_at TEXT NOT NULL CHECK (trim(created_at) <> ''),
          updated_at TEXT NOT NULL CHECK (trim(updated_at) <> ''),
          ${MESSAGE_CONTENT_INVARIANT},
          FOREIGN KEY (conversation_id) REFERENCES workspace_content_conversations(id)
            ON UPDATE CASCADE ON DELETE CASCADE
        );
        INSERT INTO workspace_content_messages_rich
          (id, conversation_id, turn_id, position, role, content, content_json, context_json,
           legacy_order_created_at,
           created_at, updated_at)
        SELECT id, conversation_id, turn_id, position, role, content, NULL, context_json, NULL,
               created_at, updated_at
        FROM workspace_content_messages;
        DROP TABLE workspace_content_messages;
        ALTER TABLE workspace_content_messages_rich RENAME TO workspace_content_messages;
        CREATE INDEX workspace_content_messages_order
          ON workspace_content_messages(conversation_id, created_at ASC, id ASC);
        CREATE INDEX workspace_content_messages_position_order
          ON workspace_content_messages(conversation_id, position ASC, id ASC);
      `)
      if ((db.pragma('foreign_key_check') as unknown[]).length > 0) {
        throw new Error('Workspace content rich-message upgrade broke a foreign-key relationship')
      }
    })()
  } finally {
    db.pragma('legacy_alter_table = OFF')
    db.pragma('foreign_keys = ON')
  }
}

function upgradeMessageLegacyOrderColumn(db: Database.Database): void {
  const columns = db.pragma('table_info(workspace_content_messages)') as Array<{ name: string }>
  if (columns.some((column) => column.name === 'legacy_order_created_at')) return
  db.exec('ALTER TABLE workspace_content_messages ADD COLUMN legacy_order_created_at TEXT')
}

function upgradeMessageOrderTokenColumn(db: Database.Database): void {
  const columns = db.pragma('table_info(workspace_content_messages)') as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'order_token_json')) {
    db.exec('ALTER TABLE workspace_content_messages ADD COLUMN order_token_json TEXT')
  }
  db.exec(`UPDATE workspace_content_messages SET order_token_json = CASE
    WHEN legacy_order_created_at IS NOT NULL THEN json_object('source','positionless_sync','createdAt',legacy_order_created_at,'messageId',id)
    ELSE json_object('source','explicit_sync','position',position,'messageId',id) END
    WHERE order_token_json IS NULL`)
}

const OUTBOX_CLAIM_COLUMNS = [
  ['claim_id', 'TEXT'],
  ['claimed_at', 'TEXT'],
  ['retry_at', 'TEXT'],
  ['origin', 'TEXT'],
  ['sync_operation_id', 'TEXT']
] as const

function outboxColumnNames(db: Database.Database): Set<string> {
  return new Set(
    (db.pragma('table_info(workspace_content_outbox)') as Array<{ name: string }>).map(
      (column) => column.name
    )
  )
}

/**
 * Additive claim/retry/origin columns for the outbox delivery owner. Existing rows predate the
 * drain being wired up, so they carry no claim state (NULL - immediately eligible) and no recorded
 * origin; backfilled to 'local' rather than left NULL so every row satisfies
 * `WorkspaceContentOutboxOrigin` once read back.
 */
function upgradeOutboxClaimColumns(db: Database.Database): void {
  const existing = outboxColumnNames(db)
  const missing = OUTBOX_CLAIM_COLUMNS.filter(([name]) => !existing.has(name))
  if (missing.length === 0) return
  db.transaction(() => {
    for (const [name, type] of missing) {
      db.exec(`ALTER TABLE workspace_content_outbox ADD COLUMN ${name} ${type}`)
    }
    if (missing.some(([name]) => name === 'origin')) {
      db.exec(`UPDATE workspace_content_outbox SET origin = 'local' WHERE origin IS NULL`)
    }
    if (missing.some(([name]) => name === 'sync_operation_id')) {
      db.exec(`UPDATE workspace_content_outbox SET sync_operation_id = id
               WHERE sync_operation_id IS NULL OR trim(sync_operation_id) = ''`)
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS workspace_content_outbox_claim_order
         ON workspace_content_outbox(delivered_at, claim_id, claimed_at, retry_at)`
    )
  })()
}

/**
 * Additive capture column for the project-deletion media phase. Existing intents predate the
 * capture, so they stay NULL and capture on their next media step.
 */
function upgradeProjectDeletionMediaColumn(db: Database.Database): void {
  const existing = new Set(
    (
      db.pragma('table_info(workspace_content_project_deletion_intents)') as Array<{
        name: string
      }>
    ).map((column) => column.name)
  )
  if (existing.has('pending_generated_image_ids_json')) return
  db.exec(
    `ALTER TABLE workspace_content_project_deletion_intents
       ADD COLUMN pending_generated_image_ids_json TEXT`
  )
}

function upgradeDeletionIntentOriginColumns(db: Database.Database): void {
  for (const table of [
    'workspace_content_project_deletion_intents',
    'workspace_content_conversation_deletion_intents'
  ]) {
    const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>
    if (columns.some((column) => column.name === 'origin')) continue
    db.exec(
      `ALTER TABLE ${table} ADD COLUMN origin TEXT NOT NULL DEFAULT 'local'
       CHECK (origin IN ('local', 'remote'))`
    )
  }
}

function upgradeDeletionIntentOperationColumns(db: Database.Database): void {
  for (const table of [
    'workspace_content_project_deletion_intents',
    'workspace_content_conversation_deletion_intents'
  ]) {
    const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>
    if (columns.some((column) => column.name === 'remote_operation_id')) continue
    db.exec(`ALTER TABLE ${table} ADD COLUMN remote_operation_id TEXT`)
  }
}

/** Install only the normalized persistence structure on the connection owned by Desktop. */
export function initializeWorkspaceContentSchema(db: Database.Database): void {
  db.pragma('foreign_keys = ON')
  if (db.pragma('foreign_keys', { simple: true }) !== 1) {
    throw new Error('Workspace content schema requires SQLite foreign-key enforcement')
  }

  db.transaction(() => db.exec(WORKSPACE_CONTENT_SCHEMA))()
  upgradeMessageContent(db)
  upgradeMessageLegacyOrderColumn(db)
  upgradeMessageOrderTokenColumn(db)
  upgradeOutboxClaimColumns(db)
  upgradeProjectDeletionMediaColumn(db)
  upgradeDeletionIntentOriginColumns(db)
  upgradeDeletionIntentOperationColumns(db)
  db.prepare(
    `INSERT OR IGNORE INTO workspace_content_revision (id, revision) VALUES (1, '0')`
  ).run()
}
