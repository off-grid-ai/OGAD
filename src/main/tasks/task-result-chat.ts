/**
 * Desktop persistence of the task -> Chat projection. Which statuses post, the copy, the safe URL
 * rule, the context key, and the stable result-message identity are `@offgrid/automation`'s
 * (`task-result`); this module only turns the decided message into one Workspace Content command.
 * Workspace Content owns the message row, the insert/update/delete decision, the conversation
 * touch, and the outbox enqueue that carries the change to Sync.
 */
import type Database from 'better-sqlite3'
import {
  taskResultChatContent,
  taskResultContext,
  taskResultConversationId,
  taskResultMessageId,
  type TaskRunSnapshot
} from '@offgrid/automation'
import { desktopWorkspaceContent } from '../composition/application-access'
import { writeDiagnosticLog } from '../diagnostics-log'

export { taskResultChatContent } from '@offgrid/automation'

/**
 * Persist the latest user-relevant task state in the Chat that started it.
 *
 * Resolves to `true` only after Workspace Content has durably committed a change, so the caller
 * can announce the new state instead of announcing an intent that may still fail. The command is
 * a single source-keyed upsert: Workspace Content decides insert, update, or removal against its
 * own committed base, on its serialized queue, so rapid task events cannot append duplicates.
 *
 * The `_db` parameter is kept only so the existing `task-history.ts` call site
 * (`persistTaskResultInChat(getDB(), snapshot)`) still type-checks unchanged; Workspace Content, not
 * this module, now owns the connection it reads and writes through.
 */
export async function persistTaskResultInChat(
  _db: Database.Database,
  task: TaskRunSnapshot
): Promise<boolean> {
  const conversationId = taskResultConversationId(task)
  if (!conversationId) return false

  const content = taskResultChatContent(task)
  const outcome = await desktopWorkspaceContent.execute({
    type: 'upsert_message',
    conversationId,
    messageId: taskResultMessageId(task),
    ...(content === undefined
      ? {}
      : {
          portable: { role: 'assistant', content },
          local: taskResultContext(task)
        })
  })

  if (!outcome.ok) {
    // A journey whose conversation was never materialized (or was deleted) has nothing to post
    // to. That is an ordinary skip, not a persistence fault.
    writeDiagnosticLog(
      'tasks',
      'task-result-chat.command_failed',
      {
        command: 'upsert_message',
        kind: outcome.failure.kind,
        message: outcome.failure.message
      },
      outcome.failure.kind === 'not_found' ? 'info' : 'error'
    )
    return false
  }
  return outcome.value.changes.length > 0
}
