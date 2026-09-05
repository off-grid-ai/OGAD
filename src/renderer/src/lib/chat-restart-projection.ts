import type { ChatTurn } from '@offgrid/application'
import { parseRagContext, type RawRagMessage } from './chat-transcript-projection'
import type { ChatMessage, RagContext } from './chat-transcript-types'
import { buildAssistantContext } from './message-persistence'

/** Render Shared restart recovery without inventing a second Desktop lifecycle state. */
export function projectRecoveredChatTurns(
  raw: readonly RawRagMessage[],
  durable: readonly ChatMessage[],
  turns: readonly ChatTurn[]
): ChatMessage[] {
  const next = [...durable]
  const userMessageIds = new Map<string, string>()
  for (const message of raw) {
    const context = parseRagContext(message.context)
    if (message.role === 'user' && typeof context?.chatTurnId === 'string') {
      userMessageIds.set(context.chatTurnId, String(message.uuid ?? message.id ?? ''))
    }
  }
  for (const turn of turns) {
    if (turn.status !== 'interrupted') continue
    let userId = userMessageIds.get(turn.id)
    if (!userId) {
      userId = `recovered-user-${turn.id}`
      next.push({ id: userId, role: 'user', content: String(turn.userMessage.content) })
    }
    const userIndex = next.findIndex((message) => message.id === userId)
    const interrupted: ChatMessage = {
      id: `recovered-assistant-${turn.id}`,
      role: 'assistant',
      content: turn.errorMessage ?? 'The response was interrupted. Retry the response.',
      context: buildAssistantContext(undefined, {
        session: {
          turnId: turn.id,
          status: turn.status,
          responseMessages: turn.responseMessages ?? [],
          reasoningRequested: turn.request.request.reasoning?.enabled === true
        }
      }) as RagContext
    }
    if (userIndex < 0) next.push(interrupted)
    else next.splice(userIndex + 1, 0, interrupted)
  }
  return next
}
