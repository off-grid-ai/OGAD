import { randomUUID } from 'node:crypto'
import type {
  ChatTurnRecord,
  ConversationRecord,
  MessageRecord,
  ProjectRecord,
  WorkspaceContentChange,
  WorkspaceContentCommitResult,
  WorkspaceContentMigrationStatus,
  WorkspaceContentOutboxClaim,
  WorkspaceContentOutboxEntry,
  WorkspaceContentOutboxOrigin,
  WorkspaceContentOutboxPrivacyCompactionPort,
  WorkspaceContentOutboxPrivacyTarget,
  WorkspaceContentOutboxTransitionResult,
  WorkspaceContentRepositoryPort,
  WorkspaceContentRepositorySnapshot,
  WorkspaceContentTransaction
} from '@offgrid/application'
import type Database from 'better-sqlite3-multiple-ciphers'
import { serializeMessageOrderToken } from '@offgrid/application'
import { compactDeletedWorkspaceContentOutbox } from './outbox-privacy-compaction'
import { WORKSPACE_CONTENT_SCHEMA_VERSION } from './schema'
import { desktopWorkspaceMessageFromRow, type DesktopWorkspaceMessageRow } from './message-codec'
import { DesktopWorkspaceContentLocalResourceReleaseOwner } from './local-resource-release'

type ProjectRow = {
  id: string
  name: string
  description: string
  system_prompt: string
  icon: string | null
  include_memory: number
  created_at: string
  updated_at: string
}

type ConversationRow = {
  id: string
  title: string
  model_id: string | null
  project_id: string | null
  compaction_summary: string | null
  compaction_cutoff_message_id: string | null
  created_at: string
  updated_at: string
}

type TurnRow = { turns_json: string }

type OutboxRow = {
  id: string
  sync_operation_id: string
  transaction_id: string
  transaction_order: number
  entity_type: WorkspaceContentChange['entity']
  entity_id: string
  operation: 'put' | 'delete'
  payload_json: string
  created_at: string
  attempt_count: number
  claim_id: string | null
  claimed_at: string | null
  retry_at?: string | null
  origin: WorkspaceContentOutboxOrigin
}

/** Desktop SQLite mechanics for the Shared workspace-content owner. */
export class DesktopWorkspaceContentRepository
  implements WorkspaceContentRepositoryPort, WorkspaceContentOutboxPrivacyCompactionPort
{
  readonly localResourceReleases: DesktopWorkspaceContentLocalResourceReleaseOwner

  constructor(private readonly db: Database.Database) {
    this.localResourceReleases = new DesktopWorkspaceContentLocalResourceReleaseOwner(db)
  }

  async read(): Promise<WorkspaceContentRepositorySnapshot> {
    await this.localResourceReleases
      .drain()
      .catch((error) =>
        console.error('[workspace-content] local resource recovery remains pending', error)
      )
    const revision = this.currentRevision()

    const projects = (
      this.db
        .prepare(
          `SELECT id, name, description, system_prompt, icon, include_memory, created_at, updated_at
         FROM workspace_content_projects ORDER BY updated_at DESC, id ASC`
        )
        .all() as ProjectRow[]
    ).map(projectFromRow)
    const conversations = (
      this.db
        .prepare(
          `SELECT id, title, model_id, project_id, compaction_summary,
                compaction_cutoff_message_id, created_at, updated_at
         FROM workspace_content_conversations ORDER BY updated_at DESC, id ASC`
        )
        .all() as ConversationRow[]
    ).map(conversationFromRow)
    const messages = (
      this.db
        .prepare(
          `SELECT m.id, m.conversation_id, m.turn_id, m.position, m.role, m.content, m.content_json,
                m.context_json, m.legacy_order_created_at, m.order_token_json, l.state_json, m.created_at, m.updated_at
         FROM workspace_content_messages m
         LEFT JOIN workspace_content_local_message_state l ON l.message_id = m.id
         ORDER BY m.position ASC, m.id ASC`
        )
        .all() as DesktopWorkspaceMessageRow[]
    ).map(desktopWorkspaceMessageFromRow)
    const chatTurns = (
      this.db
        .prepare('SELECT turns_json FROM workspace_content_chat_turns ORDER BY conversation_id ASC')
        .all() as TurnRow[]
    )
      .flatMap(({ turns_json }) => parseJson<ChatTurnRecord[]>(turns_json))
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
      )

    return {
      revision,
      migration: this.migrationStatus(),
      projects,
      conversations,
      messages,
      chatTurns
    }
  }

  async commit(transaction: WorkspaceContentTransaction): Promise<WorkspaceContentCommitResult> {
    const result = this.db.transaction(() => {
      const current = this.currentRevision()
      if (current !== transaction.expectedRevision) {
        return { committed: false as const, reason: 'revision_conflict' as const }
      }
      if (transaction.changes.length === 0) return { committed: true as const, revision: current }

      const revision = randomUUID()
      const createdAt = new Date().toISOString()
      for (const [order, change] of transaction.changes.entries()) {
        const outboxId = transaction.outbox === 'enqueue' ? randomUUID() : undefined,
          syncOperationId = transaction.outboxOperationIds?.[order] ?? outboxId
        this.apply(change, syncOperationId)
        if (transaction.outbox === 'skip') continue
        this.db
          .prepare(
            `INSERT INTO workspace_content_outbox
               (id, sync_operation_id, transaction_id, transaction_order, entity_type, entity_id, operation,
                payload_json, origin, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            outboxId,
            syncOperationId,
            revision,
            order,
            change.entity,
            change.kind === 'put' ? change.record.id : change.id,
            change.kind,
            JSON.stringify(change.kind === 'put' ? change.record : { id: change.id }),
            // Shared guarantees `outbox: 'enqueue'` only for a non-remote origin: a remote commit
            // always carries `outbox: 'skip'`, which this branch never reaches.
            transaction.origin as WorkspaceContentOutboxOrigin,
            createdAt
          )
      }
      this.localResourceReleases.insert(
        revision,
        transaction.localResourceReleases ?? [],
        createdAt
      )
      this.db
        .prepare('UPDATE workspace_content_revision SET revision = ? WHERE id = 1')
        .run(revision)
      return { committed: true as const, revision }
    })()
    if (result.committed) {
      await this.localResourceReleases
        .drain()
        .catch((error) =>
          console.error('[workspace-content] local resource release remains pending', error)
        )
    }
    return result
  }

  async claimOutbox(
    claim: WorkspaceContentOutboxClaim
  ): Promise<readonly WorkspaceContentOutboxEntry[]> {
    return this.db.transaction(() => {
      const candidates = this.db
        .prepare(
          `SELECT id, claim_id, claimed_at, retry_at FROM workspace_content_outbox
           WHERE delivered_at IS NULL
           ORDER BY rowid ASC
           LIMIT ?`
        )
        .all(claim.limit) as Array<Pick<OutboxRow, 'id' | 'claim_id' | 'claimed_at' | 'retry_at'>>
      const blockedAt = candidates.findIndex((row) => !outboxEntryIsDue(row, claim))
      const rows = candidates.slice(0, blockedAt === -1 ? candidates.length : blockedAt)

      const claimed: OutboxRow[] = []
      for (const { id } of rows) {
        this.db
          .prepare(
            `UPDATE workspace_content_outbox
             SET claim_id = ?, claimed_at = ?, attempt_count = attempt_count + 1
             WHERE id = ?`
          )
          .run(claim.claimId, claim.claimedAt, id)
        const row = this.db
          .prepare(
            `SELECT id, sync_operation_id, transaction_id, transaction_order, entity_type, entity_id, operation,
                  payload_json, created_at, attempt_count, claim_id, claimed_at, origin
             FROM workspace_content_outbox WHERE id = ?`
          )
          .get(id) as OutboxRow
        claimed.push(row)
      }
      return claimed.map(outboxEntryFromRow)
    })()
  }

  async compactDeletedOutbox(
    targets: readonly WorkspaceContentOutboxPrivacyTarget[]
  ): Promise<ReturnType<typeof compactDeletedWorkspaceContentOutbox>> {
    return compactDeletedWorkspaceContentOutbox(this.db, targets)
  }

  async acknowledgeOutbox(input: {
    readonly entryId: string
    readonly claimId: string
    readonly deliveredAt: string
  }): Promise<WorkspaceContentOutboxTransitionResult> {
    const result = this.db
      .prepare(
        `UPDATE workspace_content_outbox SET delivered_at = ?
         WHERE id = ? AND claim_id = ? AND delivered_at IS NULL`
      )
      .run(input.deliveredAt, input.entryId, input.claimId)
    return result.changes > 0 ? { applied: true } : { applied: false, reason: 'stale_claim' }
  }

  async failOutboxAttempt(input: {
    readonly entryId: string
    readonly claimId: string
    readonly failedAt: string
    readonly retryAt: string
    readonly message: string
  }): Promise<WorkspaceContentOutboxTransitionResult> {
    const result = this.db
      .prepare(
        `UPDATE workspace_content_outbox
         SET claim_id = NULL, claimed_at = NULL, retry_at = ?, last_error = ?
         WHERE id = ? AND claim_id = ? AND delivered_at IS NULL`
      )
      .run(input.retryAt, input.message, input.entryId, input.claimId)
    return result.changes > 0 ? { applied: true } : { applied: false, reason: 'stale_claim' }
  }

  private currentRevision(): string {
    return (
      (this.db
        .prepare('SELECT revision FROM workspace_content_revision WHERE id = 1')
        .pluck()
        .get() as string | undefined) ?? '0'
    )
  }

  private migrationStatus(): WorkspaceContentMigrationStatus {
    const row = this.db
      .prepare(
        `SELECT target_version, status, failure_message
         FROM workspace_content_migration_journal ORDER BY target_version DESC LIMIT 1`
      )
      .get() as
      | {
          target_version: number
          status: 'started' | 'completed' | 'failed'
          failure_message: string | null
        }
      | undefined
    if (!row) return { phase: 'not_started', targetVersion: WORKSPACE_CONTENT_SCHEMA_VERSION }
    if (row.status === 'completed') return { phase: 'current', version: row.target_version }
    if (row.status === 'failed') {
      return {
        phase: 'failed',
        targetVersion: row.target_version,
        message: row.failure_message ?? 'Workspace content migration failed.'
      }
    }
    return { phase: 'migrating', targetVersion: row.target_version, completed: 0, total: 1 }
  }

  private apply(change: WorkspaceContentChange, syncOperationId: string | undefined): void {
    if (change.kind === 'delete') {
      this.applyDelete(change.entity, change.id)
      return
    }
    if (change.entity === 'project') this.putProject(change.record, syncOperationId)
    else if (change.entity === 'conversation') this.putConversation(change.record)
    else if (change.entity === 'message') this.putMessage(change.record)
    else this.putTurn(change.record)
  }

  private applyDelete(entity: WorkspaceContentChange['entity'], id: string): void {
    const tables = {
      project: 'workspace_content_projects',
      conversation: 'workspace_content_conversations',
      message: 'workspace_content_messages'
    } as const
    if (entity !== 'chat_turns') {
      this.db.prepare(`DELETE FROM ${tables[entity]} WHERE id = ?`).run(id)
      return
    }
    const rows = this.db
      .prepare('SELECT conversation_id, turns_json FROM workspace_content_chat_turns')
      .all() as Array<{ conversation_id: string; turns_json: string }>
    for (const row of rows) {
      const turns = parseJson<ChatTurnRecord[]>(row.turns_json)
      const next = turns.filter((turn) => turn.id !== id)
      if (next.length !== turns.length) this.writeTurns(row.conversation_id, next)
    }
  }

  private putProject(record: ProjectRecord, syncOperationId: string | undefined): void {
    this.db
      .prepare(
        `INSERT INTO workspace_content_projects
         (id, sync_operation_id, name, description, system_prompt, icon, include_memory, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
         system_prompt=excluded.system_prompt, icon=excluded.icon,
         include_memory=excluded.include_memory, created_at=excluded.created_at,
         updated_at=excluded.updated_at`
      )
      .run(
        record.id,
        syncOperationId,
        record.name,
        record.description,
        record.systemPrompt,
        record.icon ?? null,
        record.includeMemory ? 1 : 0,
        record.createdAt,
        record.updatedAt
      )
  }

  private putConversation(record: ConversationRecord): void {
    this.db
      .prepare(
        `INSERT INTO workspace_content_conversations
         (id, title, model_id, project_id, compaction_summary, compaction_cutoff_message_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, model_id=excluded.model_id,
         project_id=excluded.project_id, compaction_summary=excluded.compaction_summary,
         compaction_cutoff_message_id=excluded.compaction_cutoff_message_id,
         created_at=excluded.created_at, updated_at=excluded.updated_at`
      )
      .run(
        record.id,
        record.title,
        record.modelId,
        record.projectId,
        record.compactionSummary ?? null,
        record.compactionCutoffMessageId ?? null,
        record.createdAt,
        record.updatedAt
      )
  }

  private putMessage(record: MessageRecord): void {
    const content = record.portable.content
    const plainContent = typeof content === 'string' ? content : null
    const richContent = typeof content === 'string' ? null : JSON.stringify(content)
    this.db
      .prepare(
        `INSERT INTO workspace_content_messages
         (id, conversation_id, turn_id, position, role, content, content_json, context_json,
          legacy_order_created_at, order_token_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET conversation_id=excluded.conversation_id,
         turn_id=excluded.turn_id, position=excluded.position, role=excluded.role,
         content=excluded.content, content_json=excluded.content_json,
         context_json=excluded.context_json,
         legacy_order_created_at=excluded.legacy_order_created_at,
         order_token_json=excluded.order_token_json,
         created_at=excluded.created_at, updated_at=excluded.updated_at`
      )
      .run(
        record.id,
        record.conversationId,
        record.turnId,
        record.position,
        record.portable.role,
        plainContent,
        richContent,
        record.portable.context ? JSON.stringify(record.portable.context) : null,
        record.legacyOrder?.createdAt ?? null,
        record.orderToken ? serializeMessageOrderToken(record.orderToken) : null,
        record.createdAt,
        record.updatedAt
      )
    if (record.local) {
      this.db
        .prepare(
          `INSERT INTO workspace_content_local_message_state (message_id, state_json) VALUES (?, ?)
         ON CONFLICT(message_id) DO UPDATE SET state_json=excluded.state_json`
        )
        .run(record.id, JSON.stringify(record.local))
    } else {
      this.db
        .prepare('DELETE FROM workspace_content_local_message_state WHERE message_id = ?')
        .run(record.id)
    }
  }

  private putTurn(record: ChatTurnRecord): void {
    const row = this.db
      .prepare('SELECT turns_json FROM workspace_content_chat_turns WHERE conversation_id = ?')
      .get(record.conversationId) as TurnRow | undefined
    const turns = row ? parseJson<ChatTurnRecord[]>(row.turns_json) : []
    const next = [...turns.filter((turn) => turn.id !== record.id), record].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    )
    this.writeTurns(record.conversationId, next)
  }

  private writeTurns(conversationId: string, turns: readonly ChatTurnRecord[]): void {
    if (turns.length === 0) {
      this.db
        .prepare('DELETE FROM workspace_content_chat_turns WHERE conversation_id = ?')
        .run(conversationId)
      return
    }
    const updatedAt = turns.reduce(
      (latest, turn) => (turn.updatedAt > latest ? turn.updatedAt : latest),
      ''
    )
    this.db
      .prepare(
        `INSERT INTO workspace_content_chat_turns (conversation_id, turns_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET turns_json=excluded.turns_json,
         updated_at=excluded.updated_at`
      )
      .run(conversationId, JSON.stringify(turns), updatedAt)
  }
}

function outboxEntryIsDue(
  row: Pick<OutboxRow, 'claim_id' | 'claimed_at' | 'retry_at'>,
  claim: WorkspaceContentOutboxClaim
): boolean {
  if (row.claim_id === null) return row.retry_at == null || row.retry_at <= claim.claimedAt
  return row.claimed_at !== null && row.claimed_at <= claim.staleBefore
}

function projectFromRow(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    systemPrompt: row.system_prompt,
    ...(row.icon ? { icon: row.icon } : {}),
    includeMemory: row.include_memory === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function conversationFromRow(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    title: row.title,
    modelId: row.model_id,
    projectId: row.project_id,
    ...(row.compaction_summary ? { compactionSummary: row.compaction_summary } : {}),
    ...(row.compaction_cutoff_message_id
      ? { compactionCutoffMessageId: row.compaction_cutoff_message_id }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function outboxChangeFromRow(row: OutboxRow): WorkspaceContentChange {
  if (row.operation === 'delete')
    return { kind: 'delete', entity: row.entity_type, id: row.entity_id }
  switch (row.entity_type) {
    case 'project':
      return { kind: 'put', entity: 'project', record: parseJson<ProjectRecord>(row.payload_json) }
    case 'conversation':
      return {
        kind: 'put',
        entity: 'conversation',
        record: parseJson<ConversationRecord>(row.payload_json)
      }
    case 'message':
      return { kind: 'put', entity: 'message', record: parseJson<MessageRecord>(row.payload_json) }
    case 'chat_turns':
      return {
        kind: 'put',
        entity: 'chat_turns',
        record: parseJson<ChatTurnRecord>(row.payload_json)
      }
  }
}

function outboxEntryFromRow(row: OutboxRow): WorkspaceContentOutboxEntry {
  return {
    id: row.id,
    syncOperationId: row.sync_operation_id,
    transactionId: row.transaction_id,
    transactionOrder: row.transaction_order,
    origin: row.origin,
    change: outboxChangeFromRow(row),
    createdAt: row.created_at,
    attempt: row.attempt_count,
    claimId: row.claim_id ?? '',
    claimedAt: row.claimed_at ?? ''
  }
}
