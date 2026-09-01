import { describe, expect, it, vi } from 'vitest'
import {
  DesktopChatSession,
  type DesktopChatSessionBoundary,
  type DesktopChatSessionInput
} from '../desktop-chat-session'

function input(turnId: string, conversationId = 'conversation-a'): DesktopChatSessionInput {
  return {
    conversationId,
    turnId,
    projectId: 'project-a',
    userMessage: { role: 'user', content: `Question ${turnId}` },
    query: `Question ${turnId}`,
    history: [],
    noMemory: false,
    thinking: true,
    images: []
  }
}

describe('DesktopChatSession', () => {
  it('uses the real shared lifecycle for streaming and durable response messages', async () => {
    let listener: Parameters<DesktopChatSessionBoundary['onRagStream']>[0] = () => undefined
    const boundary: DesktopChatSessionBoundary = {
      ragChat: vi.fn(async (_query, _app, _history, _project, _conversation, _noMemory, id) => {
        listener({ streamId: id, type: 'reasoning', text: 'Checking memory. ' })
        listener({ streamId: id, type: 'content', text: 'Shared answer' })
        return { answer: 'Shared answer', context: { sources: [] } }
      }),
      onRagStream: vi.fn((next) => {
        listener = next
        return () => {
          listener = () => undefined
        }
      }),
      cancelRag: vi.fn()
    }
    const session = new DesktopChatSession(boundary)
    const events: string[] = []
    session.subscribe((event) => events.push(event.type))

    const result = await session.send(input('turn-a'))

    expect(result.response.answer).toBe('Shared answer')
    expect(result.turn.status).toBe('completed')
    expect(result.turn.responseMessages).toEqual([{ role: 'assistant', content: 'Shared answer' }])
    expect(events).toEqual(
      expect.arrayContaining(['queued', 'started', 'partial', 'completed', 'queue_changed'])
    )
  })

  it('uses the shared per-conversation queue and cancellation owner', async () => {
    const resolvers: Array<() => void> = []
    const boundary: DesktopChatSessionBoundary = {
      ragChat: vi.fn(
        () =>
          new Promise<{ answer: string }>((resolve) => {
            resolvers.push(() => resolve({ answer: 'done' }))
          })
      ),
      onRagStream: () => () => undefined,
      cancelRag: vi.fn()
    }
    const session = new DesktopChatSession(boundary)
    const first = session.send(input('turn-a'))
    const second = session.send(input('turn-b'))

    await vi.waitFor(() => expect(resolvers).toHaveLength(1))
    expect(session.queueProjection().entries).toEqual([
      { conversationId: 'conversation-a', turnId: 'turn-a', status: 'running' },
      { conversationId: 'conversation-a', turnId: 'turn-b', status: 'queued', position: 0 }
    ])

    expect(session.stopConversation('conversation-a', 'stop')).toBe(2)
    expect(boundary.cancelRag).toHaveBeenCalledWith('turn-a')
    resolvers[0]!()
    await first
    await second
    expect(session.queueProjection().entries).toEqual([])
  })
})
