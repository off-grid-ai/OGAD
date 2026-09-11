import type {
  ConversationDeletionIntent,
  ConversationDeletionIntentRepositoryPort
} from '@offgrid/application'
import type Database from 'better-sqlite3-multiple-ciphers'
import { isPersistedWinningOperation } from './remote-deletion-winner'

type IntentRow = {
  conversation_id: string
  state: ConversationDeletionIntent['state']
  phase: ConversationDeletionIntent['phase']
  image_ids_json: string
  origin: unknown
  remote_operation_id: string | null
  attempt: number
  updated_at: string
  last_failure: string | null
}

function intentFromRow(row: IntentRow): ConversationDeletionIntent {
  const imageIds: unknown = JSON.parse(row.image_ids_json)
  if (!Array.isArray(imageIds) || imageIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new Error(
      `Conversation deletion intent ${row.conversation_id} has invalid image identities.`
    )
  }
  return {
    conversationId: row.conversation_id,
    origin: intentOrigin(row.origin, row.conversation_id),
    ...(row.remote_operation_id ? { remoteOperationId: row.remote_operation_id } : {}),
    imageIds,
    state: row.state,
    phase: row.phase,
    attempt: row.attempt,
    updatedAt: row.updated_at,
    ...(row.last_failure === null ? {} : { lastFailure: row.last_failure })
  }
}

/** SQLite mechanics only. Shared owns deletion phases, retry, and identity capture. */
export class DesktopConversationDeletionIntentRepository implements ConversationDeletionIntentRepositoryPort {
  constructor(private readonly db: Database.Database) {}

  async read(conversationId: string): Promise<ConversationDeletionIntent | undefined> {
    const row = this.db
      .prepare(
        `SELECT conversation_id, origin, remote_operation_id, state, phase, image_ids_json, attempt, updated_at, last_failure
         FROM workspace_content_conversation_deletion_intents WHERE conversation_id = ?`
      )
      .get(conversationId) as IntentRow | undefined
    return row ? intentFromRow(row) : undefined
  }

  async pending(): Promise<readonly ConversationDeletionIntent[]> {
    return (
      this.db
        .prepare(
          `SELECT conversation_id, origin, remote_operation_id, state, phase, image_ids_json, attempt, updated_at, last_failure
           FROM workspace_content_conversation_deletion_intents
           WHERE state != 'completed' ORDER BY updated_at ASC, conversation_id ASC`
        )
        .all() as IntentRow[]
    )
      .map(intentFromRow)
      .filter((intent) => this.retainCurrent(intent))
  }

  async save(intent: ConversationDeletionIntent): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO workspace_content_conversation_deletion_intents
         (conversation_id, origin, remote_operation_id, state, phase, image_ids_json, attempt, updated_at, last_failure)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           origin=excluded.origin, remote_operation_id=excluded.remote_operation_id,
           state=excluded.state, phase=excluded.phase,
           image_ids_json=excluded.image_ids_json,
           attempt=excluded.attempt, updated_at=excluded.updated_at,
           last_failure=excluded.last_failure`
      )
      .run(
        intent.conversationId,
        intentOrigin(intent.origin, intent.conversationId),
        intent.remoteOperationId ?? null,
        intent.state,
        intent.phase,
        JSON.stringify(intent.imageIds),
        intent.attempt,
        intent.updatedAt,
        intent.lastFailure ?? null
      )
  }

  async discard(conversationId: string): Promise<void> {
    this.db
      .prepare(
        'DELETE FROM workspace_content_conversation_deletion_intents WHERE conversation_id = ?'
      )
      .run(conversationId)
  }

  private retainCurrent(intent: ConversationDeletionIntent): boolean {
    if (intent.origin !== 'remote') return true
    if (!intent.remoteOperationId) {
      throw new Error(
        `Remote conversation deletion intent ${intent.conversationId} has no operation identity.`
      )
    }
    if (
      isPersistedWinningOperation({
        db: this.db,
        entity: 'conversation',
        entityId: intent.conversationId,
        operationId: intent.remoteOperationId
      })
    ) {
      return true
    }
    this.db
      .prepare(
        'DELETE FROM workspace_content_conversation_deletion_intents WHERE conversation_id = ?'
      )
      .run(intent.conversationId)
    return false
  }
}

function intentOrigin(value: unknown, id: string): 'local' | 'remote' {
  if (value === 'local' || value === 'remote') return value
  throw new Error(`Conversation deletion intent ${id} has invalid origin ${String(value)}.`)
}
