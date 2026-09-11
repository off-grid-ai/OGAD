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

type ReasonInput = Omit<WorkspaceContentMigrationReason, 'detail'>
type RowCheck = Omit<ReasonInput, 'count'> & { predicate: string }
type ColumnInspection = {
  table: WorkspaceContentTable
  names: ReadonlySet<string>
  expected: readonly string[]
  severity: WorkspaceContentMigrationReason['severity']
}

class WorkspaceContentMigrationInspection {
  private readonly counts = Object.fromEntries(TABLES.map((table) => [table, 0])) as Record<
    WorkspaceContentTable,
    number
  >
  private readonly reasons: WorkspaceContentMigrationReason[] = []
  private readonly columns = new Map<WorkspaceContentTable, Set<string>>()

  constructor(private readonly db: Database.Database) {}

  inspect(): WorkspaceContentMigrationPreflight {
    this.inspectTables()
    this.inspectRows()
    if (Object.values(this.counts).every((count) => count === 0)) {
      return { status: 'current', counts: this.counts, reasons: [] }
    }
    return {
      status: this.reasons.some(({ severity }) => severity === 'malformed')
        ? 'malformed'
        : this.reasons.length > 0
          ? 'needs_migration'
          : 'current',
      counts: this.counts,
      reasons: this.reasons
    }
  }

  private inspectTables(): void {
    for (const table of TABLES) {
      if (!this.tableExists(table)) {
        this.addReason({ table, code: 'missing_table', count: 1, severity: 'malformed' })
        continue
      }
      this.counts[table] = (
        this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
      ).count
      const names = new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
          ({ name }) => name
        )
      )
      this.columns.set(table, names)
      this.inspectColumns({
        table,
        names,
        expected: TABLE_SPECS[table].required,
        severity: 'malformed'
      })
      this.inspectColumns({
        table,
        names,
        expected: TABLE_SPECS[table].current,
        severity: 'needs_migration'
      })
    }
  }

  private tableExists(table: WorkspaceContentTable): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
    )
  }

  private inspectColumns(input: ColumnInspection): void {
    for (const name of input.expected) {
      if (!input.names.has(name)) {
        this.reasons.push({
          table: input.table,
          code: 'missing_column',
          count: 1,
          detail:
            input.severity === 'malformed'
              ? `Required column ${input.table}.${name} is absent`
              : `Legacy schema lacks ${input.table}.${name}`,
          severity: input.severity
        })
      }
    }
  }

  private inspectRows(): void {
    const checks: readonly RowCheck[] = [
      {
        table: 'projects',
        code: 'missing_identity',
        predicate: "id IS NULL OR trim(id) = '' OR trim(name) = ''",
        severity: 'malformed'
      },
      {
        table: 'rag_conversations',
        code: 'missing_identity',
        predicate: "id IS NULL OR trim(id) = ''",
        severity: 'malformed'
      },
      {
        table: 'rag_messages',
        code: 'missing_identity',
        predicate: "conversation_id IS NULL OR trim(conversation_id) = ''",
        severity: 'malformed'
      },
      {
        table: 'projects',
        code: 'missing_timestamp',
        predicate: 'created_at IS NULL OR updated_at IS NULL',
        severity: 'needs_migration'
      },
      {
        table: 'rag_conversations',
        code: 'missing_timestamp',
        predicate: 'created_at IS NULL OR updated_at IS NULL',
        severity: 'needs_migration'
      },
      {
        table: 'rag_messages',
        code: 'missing_timestamp',
        predicate: 'created_at IS NULL',
        severity: 'needs_migration'
      }
    ]
    for (const check of checks) this.addRowCount(check)
    this.inspectMessageIdentities()
    this.inspectRelations()
    this.inspectTurnPayloads()
  }

  private inspectMessageIdentities(): void {
    if (!this.columns.get('rag_messages')?.has('uuid')) return
    this.addRowCount({
      table: 'rag_messages',
      code: 'missing_message_uuid',
      predicate: "uuid IS NULL OR trim(uuid) = ''",
      severity: 'needs_migration'
    })
    const duplicateCount = (
      this.db
        .prepare(
          "SELECT COALESCE(SUM(n - 1), 0) AS count FROM (SELECT COUNT(*) AS n FROM rag_messages WHERE uuid IS NOT NULL AND trim(uuid) <> '' GROUP BY uuid HAVING n > 1)"
        )
        .get() as { count: number }
    ).count
    if (duplicateCount > 0) {
      this.addReason({
        table: 'rag_messages',
        code: 'duplicate_message_uuid',
        count: duplicateCount,
        severity: 'malformed'
      })
    }
  }

  private inspectRelations(): void {
    if (
      this.columns.get('rag_conversations')?.has('project_id') &&
      this.columns.get('projects')?.has('id')
    ) {
      this.addRowCount({
        table: 'rag_conversations',
        code: 'orphaned_project',
        predicate:
          "project_id IS NOT NULL AND trim(project_id) <> '' AND NOT EXISTS (SELECT 1 FROM projects WHERE projects.id = rag_conversations.project_id)",
        severity: 'needs_migration'
      })
    }
    if (this.columns.get('rag_conversations')?.has('id')) {
      this.addRowCount({
        table: 'rag_messages',
        code: 'orphaned_conversation',
        predicate:
          'NOT EXISTS (SELECT 1 FROM rag_conversations WHERE rag_conversations.id = rag_messages.conversation_id)',
        severity: 'malformed'
      })
      this.addRowCount({
        table: 'chat_session_turns',
        code: 'orphaned_conversation',
        predicate:
          'NOT EXISTS (SELECT 1 FROM rag_conversations WHERE rag_conversations.id = chat_session_turns.conversation_id)',
        severity: 'malformed'
      })
    }
  }

  private inspectTurnPayloads(): void {
    if (!this.columns.get('chat_session_turns')?.has('turns_json')) return
    const rows = this.db.prepare('SELECT turns_json FROM chat_session_turns').all() as {
      turns_json: string
    }[]
    const invalid = rows.filter(({ turns_json }) => {
      try {
        return !Array.isArray(JSON.parse(turns_json))
      } catch {
        return true
      }
    }).length
    if (invalid > 0) {
      this.addReason({
        table: 'chat_session_turns',
        code: 'invalid_turns_json',
        count: invalid,
        severity: 'malformed'
      })
    }
  }

  private addRowCount(check: RowCheck): void {
    const requiredColumns = TABLE_SPECS[check.table].required
    if (
      !this.columns.has(check.table) ||
      requiredColumns.some((name) => !this.columns.get(check.table)?.has(name))
    ) {
      return
    }
    const count = (
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM ${check.table} WHERE ${check.predicate}`)
        .get() as { count: number }
    ).count
    if (count > 0) this.addReason({ ...check, count })
  }

  private addReason(reason: ReasonInput): void {
    this.reasons.push({
      ...reason,
      detail: `${reason.count} ${reason.table} row(s): ${reason.code}`
    })
  }
}

/**
 * Inspect the existing Desktop SQLite owner without changing schema or data.
 *
 * `needs_migration` means the data has a deterministic normalization path. `malformed` means a
 * parent, identity, or payload is missing and migration must stop for an explicit repair policy.
 */
export function inspectWorkspaceContentMigration(
  db: Database.Database
): WorkspaceContentMigrationPreflight {
  return new WorkspaceContentMigrationInspection(db).inspect()
}
