/**
 * The chat the user is currently in.
 *
 * Exists so surfaces OUTSIDE the chat component tree can bind their work to the
 * active chat without threading the id through every caller. A Chat link click
 * (openChatLink) opens a browser tab and needs to tag it with the owning chat so
 * the docked pane scopes it there - but the link handler lives deep in the
 * markdown renderer, far from where activeConversationId is held. MemoryChat is
 * the single writer; readers ask via getActiveConversationId.
 */

let activeConversationId: string | null = null

export function setActiveConversationId(id: string | null): void {
  activeConversationId = id
}

export function getActiveConversationId(): string | null {
  return activeConversationId
}
