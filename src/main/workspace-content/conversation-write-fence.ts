import { getDB } from '../database'

export class ConversationWriteFencedError extends Error {
  constructor(readonly conversationId: string) {
    super(`Conversation ${conversationId} is missing or being deleted.`)
    this.name = 'ConversationWriteFencedError'
  }
}

export interface CanonicalConversationWriteReceipt<Result> {
  readonly value: Result
  /** Reverse only bytes this exact operation owns when SQLite cannot commit. */
  readonly compensate?: () => void
}

type Synchronous<Result> = Result extends PromiseLike<unknown> ? never : Result

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** Hold SQLite's synchronous write lane across a local sidecar write. */
export function withCanonicalConversationWrite<Result>(
  conversationId: string,
  operation: () => CanonicalConversationWriteReceipt<Synchronous<Result>>
): Synchronous<Result> {
  let receipt: CanonicalConversationWriteReceipt<Synchronous<Result>> | undefined
  try {
    return getDB().transaction(() => {
      const conversation = getDB()
        .prepare('SELECT 1 FROM workspace_content_conversations WHERE id = ?')
        .get(conversationId)
      const deletion = getDB()
        .prepare(
          `SELECT 1 FROM workspace_content_conversation_deletion_intents
           WHERE conversation_id = ? AND state != 'completed'`
        )
        .get(conversationId)
      if (!conversation || deletion) throw new ConversationWriteFencedError(conversationId)
      const outcome = operation()
      if (isPromiseLike(outcome)) {
        throw new TypeError('A canonical conversation write must be synchronous.')
      }
      receipt = outcome
      if (isPromiseLike(outcome.value)) {
        throw new TypeError('A canonical conversation write value must be synchronous.')
      }
      return outcome.value
    })()
  } catch (error) {
    try {
      receipt?.compensate?.()
    } catch (compensationError) {
      throw new AggregateError(
        [error, compensationError],
        'The canonical conversation write and its compensation both failed.',
        { cause: error }
      )
    }
    throw error
  }
}
