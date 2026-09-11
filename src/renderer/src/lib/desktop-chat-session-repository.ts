import type { ChatSessionRepositoryPort, ChatTurn } from '@offgrid/models'

export interface DesktopTurnPersistencePort {
  readChatSessionTurns?(conversationId: string): Promise<ChatTurn[]>
  writeChatSessionTurns?(conversationId: string, turns: readonly ChatTurn[]): Promise<void>
}

/** Renderer-owned persistence projection used by the shared chat lifecycle. */
export class DesktopTurnRepository implements ChatSessionRepositoryPort {
  constructor(private readonly persistence?: DesktopTurnPersistencePort) {}

  async read(conversationId: string): Promise<readonly ChatTurn[]> {
    const read = this.persistence?.readChatSessionTurns
    if (!read) throw new Error('Desktop chat-session read persistence is unavailable.')
    return read(conversationId)
  }

  async write(conversationId: string, turns: readonly ChatTurn[]): Promise<void> {
    const write = this.persistence?.writeChatSessionTurns
    if (!write) throw new Error('Desktop chat-session write persistence is unavailable.')
    await write(conversationId, turns)
  }

  invalidate(_conversationId: string): void {
    // The main-process Workspace Content repository is stateless, so there is no local cache.
  }
}
