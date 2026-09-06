/**
 * Desktop persistence of the task -> Chat projection. Which statuses post, the copy, the safe URL
 * rule, and the context key are `@offgrid/automation`'s (`task-result`); this module only writes
 * the decided message into the Chat's SQLite rows and emits the sync mutations.
 */
import type Database from 'better-sqlite3'
import {
  isTaskResultContextFor,
  taskResultChatContent,
  taskResultContext,
  taskResultConversationId,
  type TaskRunSnapshot
} from '@offgrid/automation'
import { addRagMessage } from '../database'
import { CORE_SYNC_ENTITIES } from '@offgrid/application'
import { emitSyncMutation } from '../sync-mutation'

export { taskResultChatContent } from '@offgrid/automation'

interface StoredMessageContext {
  uuid: string
  content: string
  context: string | null
}

function touchConversation(db: Database.Database, conversationId: string): void {
  db.prepare('UPDATE rag_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    conversationId
  )
  emitSyncMutation({
    entity: CORE_SYNC_ENTITIES.conversation,
    entityId: conversationId,
    kind: 'put'
  })
}

/** Persist the latest user-relevant task state in the Chat that started it. */
export function persistTaskResultInChat(db: Database.Database, task: TaskRunSnapshot): boolean {
  const conversationId = taskResultConversationId(task)
  if (!conversationId) return false

  const conversation = db
    .prepare('SELECT 1 FROM rag_conversations WHERE id = ? LIMIT 1')
    .get(conversationId)
  if (!conversation) return false

  const messages = db
    .prepare(
      `SELECT uuid, content, context
       FROM rag_messages
       WHERE conversation_id = ? AND role = 'assistant' AND context IS NOT NULL`
    )
    .all(conversationId) as StoredMessageContext[]

  const existing = messages.find(({ context }) => isTaskResultContextFor(context, task.taskId))
  const content = taskResultChatContent(task)
  if (!content) {
    if (!existing) return false
    db.prepare('DELETE FROM rag_messages WHERE uuid = ?').run(existing.uuid)
    emitSyncMutation({
      entity: CORE_SYNC_ENTITIES.message,
      entityId: existing.uuid,
      kind: 'delete'
    })
    touchConversation(db, conversationId)
    return true
  }
  if (existing) {
    if (existing.content === content) return false
    db.prepare('UPDATE rag_messages SET content = ?, context = ? WHERE uuid = ?').run(
      content,
      JSON.stringify(taskResultContext(task)),
      existing.uuid
    )
    emitSyncMutation({ entity: CORE_SYNC_ENTITIES.message, entityId: existing.uuid, kind: 'put' })
    touchConversation(db, conversationId)
    return true
  }

  addRagMessage(conversationId, 'assistant', content, taskResultContext(task))
  return true
}
