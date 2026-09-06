import type Database from 'better-sqlite3-multiple-ciphers'

export type WorkspaceContentMigrationStatus = 'current' | 'needs_migration' | 'malformed'

export type WorkspaceContentTable =
  'projects' | 'rag_conversations' | 'rag_messages' | 'chat_session_turns'

export interface WorkspaceContentMigrationReason {
  table: WorkspaceContentTable
  code:
    | 'missing_table'
    | 'missing_column'
    | 'missing_identity'
    | 'missing_timestamp'
    | 'missing_message_uuid'
    | 'duplicate_message_uuid'
    | 'orphaned_project'
    | 'orphaned_conversation'
    | 'invalid_turns_json'
  count: number
  detail: string
  severity: Exclude<WorkspaceContentMigrationStatus, 'current'>
}

export interface WorkspaceContentMigrationPreflight {
  status: WorkspaceContentMigrationStatus
  counts: Record<WorkspaceContentTable, number>
  reasons: WorkspaceContentMigrationReason[]
}

type TableSpec = {
  required: readonly string[]
  current: readonly string[]
}

const TABLE_SPECS: Record<WorkspaceContentTable, TableSpec> = {
  projects: {
    required: ['id', 'name', 'created_at', 'updated_at'],
    current: [
      'description',
      'system_prompt',
      'icon',
      'include_memory',
      'origin_device_id',
      'origin_device_name'
    ]
  },
  rag_conversations: {
    required: ['id', 'title', 'created_at', 'updated_at'],
    current: ['project_id', 'origin_device_id', 'origin_device_name']
  },
  rag_messages: {
    required: ['id', 'conversation_id', 'role', 'content', 'created_at'],
    current: ['uuid', 'context', 'origin_device_id', 'origin_device_name']
  },
  chat_session_turns: {
    required: ['conversation_id', 'turns_json', 'updated_at'],
    current: []
  }
}

const TABLES = Object.keys(TABLE_SPECS) as WorkspaceContentTable[]

/**
 * Inspect the existing Desktop SQLite owner without changing schema or data.
 *
 * `needs_migration` means the data has a deterministic normalization path. `malformed` means a
 * parent, identity, or payload is missing and migration must stop for an explicit repair policy.
 */
export function inspectWorkspaceContentMigration(
  db: Database.Database
): WorkspaceContentMigrationPreflight {
  const counts = Object.fromEntries(TABLES.map((table) => [table, 0])) as Record<
    WorkspaceContentTable,
    number
  >
  const reasons: WorkspaceContentMigrationReason[] = []
  const columns = new Map<WorkspaceContentTable, Set<string>>()

  for (const table of TABLES) {
    const exists = Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
    )
    if (!exists) {
      reasons.push({
        table,
        code: 'missing_table',
        count: 1,
        detail: `Required table ${table} is absent`,
        severity: 'malformed'
      })
      continue
    }

    counts[table] = (
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
    ).count
    const names = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        ({ name }) => name
      )
    )
    columns.set(table, names)

    for (const name of TABLE_SPECS[table].required) {
      if (!names.has(name)) {
        reasons.push({
          table,
          code: 'missing_column',
          count: 1,
          detail: `Required column ${table}.${name} is absent`,
          severity: 'malformed'
        })
      }
    }
    for (const name of TABLE_SPECS[table].current) {
      if (!names.has(name)) {
        reasons.push({
          table,
          code: 'missing_column',
          count: 1,
          detail: `Legacy schema lacks ${table}.${name}`,
          severity: 'needs_migration'
        })
      }
    }
  }

  addRowCount(
    'projects',
    'missing_identity',
    "id IS NULL OR trim(id) = '' OR trim(name) = ''",
    'malformed'
  )
  addRowCount('rag_conversations', 'missing_identity', "id IS NULL OR trim(id) = ''", 'malformed')
  addRowCount(
    'rag_messages',
    'missing_identity',
    "conversation_id IS NULL OR trim(conversation_id) = ''",
    'malformed'
  )
  addRowCount(
    'projects',
    'missing_timestamp',
    'created_at IS NULL OR updated_at IS NULL',
    'needs_migration'
  )
  addRowCount(
    'rag_conversations',
    'missing_timestamp',
    'created_at IS NULL OR updated_at IS NULL',
    'needs_migration'
  )
  addRowCount('rag_messages', 'missing_timestamp', 'created_at IS NULL', 'needs_migration')

  if (columns.get('rag_messages')?.has('uuid')) {
    addRowCount(
      'rag_messages',
      'missing_message_uuid',
      "uuid IS NULL OR trim(uuid) = ''",
      'needs_migration'
    )
    const duplicateCount = (
      db
        .prepare(
          "SELECT COALESCE(SUM(n - 1), 0) AS count FROM (SELECT COUNT(*) AS n FROM rag_messages WHERE uuid IS NOT NULL AND trim(uuid) <> '' GROUP BY uuid HAVING n > 1)"
        )
        .get() as { count: number }
    ).count
    if (duplicateCount > 0) {
      addReason('rag_messages', 'duplicate_message_uuid', duplicateCount, 'malformed')
    }
  }

  if (columns.get('rag_conversations')?.has('project_id') && columns.get('projects')?.has('id')) {
    addRowCount(
      'rag_conversations',
      'orphaned_project',
      "project_id IS NOT NULL AND trim(project_id) <> '' AND NOT EXISTS (SELECT 1 FROM projects WHERE projects.id = rag_conversations.project_id)",
      'needs_migration'
    )
  }
  if (
    columns.get('rag_messages')?.has('conversation_id') &&
    columns.get('rag_conversations')?.has('id')
  ) {
    addRowCount(
      'rag_messages',
      'orphaned_conversation',
      'NOT EXISTS (SELECT 1 FROM rag_conversations WHERE rag_conversations.id = rag_messages.conversation_id)',
      'malformed'
    )
  }
  if (
    columns.get('chat_session_turns')?.has('conversation_id') &&
    columns.get('rag_conversations')?.has('id')
  ) {
    addRowCount(
      'chat_session_turns',
      'orphaned_conversation',
      'NOT EXISTS (SELECT 1 FROM rag_conversations WHERE rag_conversations.id = chat_session_turns.conversation_id)',
      'malformed'
    )
  }
  if (columns.get('chat_session_turns')?.has('turns_json')) {
    const rows = db.prepare('SELECT turns_json FROM chat_session_turns').all() as {
      turns_json: string
    }[]
    const invalid = rows.filter(({ turns_json }) => {
      try {
        return !Array.isArray(JSON.parse(turns_json))
      } catch {
        return true
      }
    }).length
    if (invalid > 0) addReason('chat_session_turns', 'invalid_turns_json', invalid, 'malformed')
  }

  // A fresh profile has no retired legacy project table and no legacy rows to copy. Missing or
  // partial legacy schema is unsafe only when it contains data whose ownership must be resolved.
  // Treating an empty source as malformed leaves startup waiting for a migration that cannot run.
  if (Object.values(counts).every((count) => count === 0)) {
    return { status: 'current', counts, reasons: [] }
  }

  return {
    status: reasons.some(({ severity }) => severity === 'malformed')
      ? 'malformed'
      : reasons.length > 0
        ? 'needs_migration'
        : 'current',
    counts,
    reasons
  }

  function addRowCount(
    table: WorkspaceContentTable,
    code: WorkspaceContentMigrationReason['code'],
    predicate: string,
    severity: WorkspaceContentMigrationReason['severity']
  ): void {
    const requiredColumns = TABLE_SPECS[table].required
    if (!columns.has(table) || requiredColumns.some((name) => !columns.get(table)?.has(name)))
      return
    const count = (
      db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`).get() as {
        count: number
      }
    ).count
    if (count > 0) addReason(table, code, count, severity)
  }

  function addReason(
    table: WorkspaceContentTable,
    code: WorkspaceContentMigrationReason['code'],
    count: number,
    severity: WorkspaceContentMigrationReason['severity']
  ): void {
    reasons.push({ table, code, count, detail: `${count} ${table} row(s): ${code}`, severity })
  }
}
