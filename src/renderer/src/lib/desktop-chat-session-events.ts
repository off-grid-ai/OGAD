import type { ChatSessionEvent } from '@offgrid/application'
import type {
  DesktopChatSessionBoundary,
  DesktopAnyChatSessionInput
} from './desktop-chat-session-contract'

interface DesktopChatEventProjection {
  event: ChatSessionEvent
  inputFor(turnId: string): DesktopAnyChatSessionInput | undefined
  boundary: DesktopChatSessionBoundary
  listeners: ReadonlySet<(event: ChatSessionEvent) => void>
}

/** Projects Shared lifecycle events to presentation listeners. Persistence belongs to ChatSession. */
export async function publishDesktopChatEvent({
  event,
  listeners
}: DesktopChatEventProjection): Promise<void> {
  for (const listener of listeners) listener(event)
}
