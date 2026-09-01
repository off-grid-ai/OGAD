import type { ChatSessionRepositoryPort, ChatTurn } from '@offgrid/models'

/** Renderer-owned persistence projection used by the shared chat lifecycle. */
export class DesktopTurnRepository implements ChatSessionRepositoryPort {
  private readonly conversations = new Map<string, ChatTurn[]>()

  async read(conversationId: string): Promise<readonly ChatTurn[]> {
    return this.conversations.get(conversationId) ?? []
  }

  async write(conversationId: string, turns: readonly ChatTurn[]): Promise<void> {
    this.conversations.set(conversationId, [...turns])
  }

  invalidate(conversationId: string): void {
    this.conversations.delete(conversationId)
  }

  restore(conversationId: string, turns: readonly ChatTurn[]): void {
    this.conversations.set(conversationId, [...turns])
  }
}
