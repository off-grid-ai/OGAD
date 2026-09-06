import type { ChatSessionRepositoryPort, ChatTurn } from '@offgrid/models'

export interface DesktopTurnPersistencePort {
  readChatSessionTurns?(conversationId: string): Promise<ChatTurn[]>
  writeChatSessionTurns?(conversationId: string, turns: readonly ChatTurn[]): Promise<void>
}

/** Renderer-owned persistence projection used by the shared chat lifecycle. */
export class DesktopTurnRepository implements ChatSessionRepositoryPort {
  private readonly conversations = new Map<string, ChatTurn[]>()

  constructor(private readonly persistence: DesktopTurnPersistencePort = {}) {}

  async read(conversationId: string): Promise<readonly ChatTurn[]> {
    const durable = await this.persistence.readChatSessionTurns?.(conversationId)
    if (durable) {
      this.conversations.set(conversationId, [...durable])
      return durable
    }
    return this.conversations.get(conversationId) ?? []
  }

  async write(conversationId: string, turns: readonly ChatTurn[]): Promise<void> {
    this.conversations.set(conversationId, [...turns])
    await this.persistence.writeChatSessionTurns?.(conversationId, turns)
  }

  invalidate(conversationId: string): void {
    this.conversations.delete(conversationId)
  }

}
