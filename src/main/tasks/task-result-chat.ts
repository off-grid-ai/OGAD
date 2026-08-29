import type Database from 'better-sqlite3'
import { addRagMessage } from '../database'
import { CORE_SYNC_ENTITIES, emitSyncMutation } from '../sync-mutation'
import type { TaskRunSnapshot } from './task-history-store'

const TASK_RESULT_CONTEXT_KEY = 'taskResult'

interface StoredMessageContext {
  uuid: string
  content: string
  context: string | null
}

function safeResultUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.href.replace(/\(/g, '%28').replace(/\)/g, '%29')
  } catch {
    return undefined
  }
}

function resultContext(task: TaskRunSnapshot): Record<string, unknown> {
  const url = task.status === 'done' ? safeResultUrl(task.lastUrl) : undefined
  return {
    [TASK_RESULT_CONTEXT_KEY]: {
      taskId: task.taskId,
      kind: task.kind,
      status: task.status,
      ...(url ? { url } : {})
    }
  }
}

const CHAT_RESULT_STATUSES = new Set<TaskRunSnapshot['status']>([
  'waiting',
  'done',
  'failed',
  'stopped'
])

function taskResultDetail(task: TaskRunSnapshot): string {
  return task.summary?.trim() || task.currentAction?.trim() || task.title.trim()
}

/** The task state owner supplies the status and detail. This one-way Chat
 * projection makes the state explicit, so a failed or stopped task can never
 * look successful because of optimistic summary text. */
export function taskResultChatContent(task: TaskRunSnapshot): string | undefined {
  if (!CHAT_RESULT_STATUSES.has(task.status)) return undefined
  const detail = taskResultDetail(task)
  if (!detail) return undefined
  if (task.status === 'waiting') return `Waiting for you: ${detail}`
  if (task.status === 'failed') return `Task failed: ${detail}`
  if (task.status === 'stopped') return `Task stopped: ${detail}`
  const url = safeResultUrl(task.lastUrl)
  return url ? `${detail}\n\n[Open the final page](${url})` : detail
}

function isResultForTask(context: string | null, taskId: string): boolean {
  if (!context) return false
  try {
    const parsed = JSON.parse(context) as Record<string, unknown>
    const result = parsed[TASK_RESULT_CONTEXT_KEY]
    return (
      typeof result === 'object' &&
      result !== null &&
      (result as Record<string, unknown>).taskId === taskId
    )
  } catch {
    return false
  }
}

/** Persist the latest user-relevant task state in the Chat that started it. */
export function persistTaskResultInChat(db: Database.Database, task: TaskRunSnapshot): boolean {
  const conversationId = task.journeyId.trim()
  if (!conversationId || conversationId === task.taskId) {
    return false
  }

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

  const existing = messages.find(({ context }) => isResultForTask(context, task.taskId))
  const content = taskResultChatContent(task)
  if (!content) {
    if (!existing) return false
    db.prepare('DELETE FROM rag_messages WHERE uuid = ?').run(existing.uuid)
    db.prepare('UPDATE rag_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      conversationId
    )
    emitSyncMutation({
      entity: CORE_SYNC_ENTITIES.message,
      entityId: existing.uuid,
      kind: 'delete'
    })
    emitSyncMutation({
      entity: CORE_SYNC_ENTITIES.conversation,
      entityId: conversationId,
      kind: 'put'
    })
    return true
  }
  if (existing) {
    if (existing.content === content) return false
    db.prepare('UPDATE rag_messages SET content = ?, context = ? WHERE uuid = ?').run(
      content,
      JSON.stringify(resultContext(task)),
      existing.uuid
    )
    db.prepare('UPDATE rag_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      conversationId
    )
    emitSyncMutation({ entity: CORE_SYNC_ENTITIES.message, entityId: existing.uuid, kind: 'put' })
    emitSyncMutation({
      entity: CORE_SYNC_ENTITIES.conversation,
      entityId: conversationId,
      kind: 'put'
    })
    return true
  }

  addRagMessage(conversationId, 'assistant', content, resultContext(task))
  return true
}
