import type { ChatSessionEvent } from '@offgrid/models'
import type {
  DesktopChatSessionBoundary,
  DesktopChatSessionInput
} from './desktop-chat-session-contract'

interface DesktopChatEventProjection {
  event: ChatSessionEvent
  inputFor(turnId: string): DesktopChatSessionInput | undefined
  boundary: DesktopChatSessionBoundary
  listeners: ReadonlySet<(event: ChatSessionEvent) => void>
}

/** Projects Shared lifecycle events to Desktop persistence and presentation ports. */
export async function publishDesktopChatEvent({
  event,
  inputFor,
  boundary,
  listeners
}: DesktopChatEventProjection): Promise<void> {
  if (event.type === 'invalidated') {
    const input = event.turnIds.map(inputFor).find((candidate) => candidate !== undefined)
    if (input?.invalidationKeepCount !== undefined && boundary.truncateRagMessages) {
      await boundary.truncateRagMessages(event.conversationId, input.invalidationKeepCount)
    }
  }
  if (event.type === 'started') {
    const input = inputFor(event.turn.id)
    const persistence = input?.userPersistence
    if (input && persistence && boundary.addRagMessage) {
      await boundary.addRagMessage(
        input.conversationId,
        'user',
        persistence.content,
        persistence.context
      )
    }
  }
  for (const listener of listeners) listener(event)
}
