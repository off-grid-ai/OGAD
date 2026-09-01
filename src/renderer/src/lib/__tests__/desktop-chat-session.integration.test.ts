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

  it('starts a new turn after stopping while durable user persistence is pending', async () => {
    let releaseWrite = (): void => undefined
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const boundary: DesktopChatSessionBoundary = {
      ragChat: vi.fn(async () => ({ answer: 'done' })),
      onRagStream: () => () => undefined,
      cancelRag: vi.fn(),
      addRagMessage: vi.fn(async () => writeGate.then(() => ({ id: 1, uuid: 'user-1' })))
    }
    const session = new DesktopChatSession(boundary)
    const first = session.send({
      ...input('turn-a'),
      userPersistence: { content: 'Question turn-a' }
    })

    await vi.waitFor(() => expect(boundary.addRagMessage).toHaveBeenCalledOnce())
    expect(session.stopConversation('conversation-a', 'stop')).toBe(1)
    releaseWrite()
    const second = session.send(input('turn-b'))

    await expect(first).resolves.toMatchObject({ turn: { status: 'stopped' } })
    await expect(second).resolves.toMatchObject({ turn: { status: 'completed' } })
    expect(boundary.ragChat).toHaveBeenCalledOnce()
  })

  it('restores a canonical turn and regenerates it through shared invalidation', async () => {
    const boundary: DesktopChatSessionBoundary = {
      ragChat: vi.fn(async () => ({ answer: 'Updated answer' })),
      onRagStream: () => () => undefined,
      cancelRag: vi.fn(),
      truncateRagMessages: vi.fn(async () => 1)
    }
    const session = new DesktopChatSession(boundary)
    session.restoreConversation('conversation-a', [
      {
        id: 'turn-a',
        conversationId: 'conversation-a',
        projectId: 'project-a',
        userMessage: { role: 'user', content: 'Question turn-a' },
        assistantMessage: { role: 'assistant', content: 'Original answer' },
        responseMessages: [{ role: 'assistant', content: 'Original answer' }],
        status: 'completed',
        request: {
          operation: { type: 'text' },
          partialOutputPolicy: 'preserve-and-stop',
          request: {}
        }
      }
    ])

    const result = await session.send({
      ...input('turn-a'),
      replay: 'regenerate',
      invalidationKeepCount: 1
    })

    expect(result.turn.status).toBe('completed')
    expect(result.response.answer).toBe('Updated answer')
    expect(boundary.truncateRagMessages).toHaveBeenCalledWith('conversation-a', 1)
  })

  it('edits a canonical turn and persists the replacement user message when it starts', async () => {
    const boundary: DesktopChatSessionBoundary = {
      ragChat: vi.fn(async () => ({ answer: 'Edited answer' })),
      onRagStream: () => () => undefined,
      cancelRag: vi.fn(),
      truncateRagMessages: vi.fn(async () => 0),
      addRagMessage: vi.fn(async () => ({ id: 2, uuid: 'edited-user' }))
    }
    const session = new DesktopChatSession(boundary)
    const original = await session.send(input('turn-a'))
    expect(original.turn.status).toBe('completed')

    const edited = await session.send({
      ...input('turn-a'),
      userMessage: { role: 'user', content: 'Edited question' },
      query: 'Edited question',
      replay: 'edit',
      invalidationKeepCount: 0,
      userPersistence: { content: 'Edited question' }
    })

    expect(edited.turn.userMessage).toEqual({ role: 'user', content: 'Edited question' })
    expect(boundary.truncateRagMessages).toHaveBeenCalledWith('conversation-a', 0)
    expect(boundary.addRagMessage).toHaveBeenCalledWith(
      'conversation-a',
      'user',
      'Edited question',
      undefined
    )
  })

  it('keeps complete tool rounds in the shared canonical response transcript', async () => {
    const boundary: DesktopChatSessionBoundary = {
      ragChat: vi.fn(async () => ({ answer: '' })),
      toolChat: vi.fn(async () => ({
        answer: 'The weather is clear.',
        toolCalls: [{ name: 'weather', result: 'Clear, 18 C', status: 'completed' as const }]
      })),
      onRagStream: () => () => undefined,
      cancelRag: vi.fn()
    }
    const session = new DesktopChatSession(boundary)

    const result = await session.send({
      ...input('turn-tools'),
      kind: 'tools',
      connectors: true,
      allMemory: true,
      imageAvailable: false
    })

    expect(result.turn.responseMessages?.map((message) => message.role)).toEqual([
      'assistant',
      'tool',
      'assistant'
    ])
    expect(result.turn.responseMessages?.[1]).toMatchObject({
      role: 'tool',
      name: 'weather',
      content: 'Clear, 18 C'
    })
  })

  it('executes deferred tool images inside the one session command', async () => {
    const boundary: DesktopChatSessionBoundary = {
      ragChat: vi.fn(async () => ({ answer: '' })),
      toolChat: vi.fn(async () => ({
        answer: 'I made the image.',
        imageRequests: [{ prompt: 'A green bicycle' }]
      })),
      generateImage: vi.fn(async () => ({
        dataUrl: 'data:image/png;base64,cG5n',
        path: '/generated/bicycle.png',
        syncId: 'bicycle-image'
      })),
      onRagStream: () => () => undefined,
      cancelRag: vi.fn()
    }
    const session = new DesktopChatSession(boundary)

    const result = await session.send({
      ...input('turn-tool-image'),
      kind: 'tools',
      connectors: false,
      allMemory: true,
      imageAvailable: true
    })

    expect(boundary.generateImage).toHaveBeenCalledWith({
      prompt: 'A green bicycle',
      conversationId: 'conversation-a',
      projectId: 'project-a'
    })
    expect(result.generatedImages).toHaveLength(1)
    expect(result.turn.responseMessages?.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'I made the image.'
    })
  })

  it('executes a text-model image hand-off inside the one session command', async () => {
    const boundary: DesktopChatSessionBoundary = {
      ragChat: vi.fn(async () => ({ answer: '```image\nA cabin at dawn\n```' })),
      generateImage: vi.fn(async () => ({
        dataUrl: 'data:image/png;base64,cG5n',
        path: '/generated/cabin.png',
        syncId: 'cabin-image'
      })),
      onRagStream: () => () => undefined,
      cancelRag: vi.fn()
    }
    const session = new DesktopChatSession(boundary)

    const result = await session.send(input('turn-rag-image'))

    expect(boundary.generateImage).toHaveBeenCalledWith({
      prompt: 'A cabin at dawn',
      conversationId: 'conversation-a',
      projectId: 'project-a'
    })
    expect(result.generatedImages[0]?.path).toBe('/generated/cabin.png')
    expect(result.turn.result?.output.type).toBe('image')
  })

  it('keeps generated image artifacts in the shared canonical response transcript', async () => {
    const boundary: DesktopChatSessionBoundary = {
      ragChat: vi.fn(async () => ({ answer: '' })),
      generateImage: vi.fn(async () => ({
        dataUrl: 'data:image/png;base64,cG5n',
        path: '/generated/image.png',
        syncId: 'image-sync-id',
        seed: 42,
        model: 'DreamShaper'
      })),
      onRagStream: () => () => undefined,
      cancelRag: vi.fn()
    }
    const session = new DesktopChatSession(boundary)

    const result = await session.send({
      ...input('turn-image'),
      kind: 'image',
      request: {
        prompt: 'A cabin at dawn',
        conversationId: 'conversation-a',
        projectId: 'project-a'
      }
    })

    expect(result.turn.responseMessages).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'image',
            id: 'image-sync-id',
            uri: '/generated/image.png',
            mimeType: 'image/png',
            seed: 42
          }
        ],
        reasoning: undefined
      }
    ])
  })
})
