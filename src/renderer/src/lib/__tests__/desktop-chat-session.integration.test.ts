import { DESKTOP_CHAT_ROUTE } from '../desktop-chat-session-policy'
import type { DesktopChatStreamEvent } from '../desktop-chat-session-contract'
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
  it('persists the Shared restart recovery state through the Desktop adapter', async () => {
    const persisted = [
      {
        id: 'turn-interrupted',
        conversationId: 'conversation-a',
        userMessage: { role: 'user' as const, content: 'Keep this request' },
        status: 'generating' as const,
        request: { operation: { type: 'text' as const }, request: {} }
      }
    ]
    const writeChatSessionTurns = vi.fn(async () => undefined)
    const boundary: DesktopChatSessionBoundary = {
      ragChat: vi.fn(async () => ({ answer: 'unused' })),
      onRagStream: () => () => undefined,
      cancelRag: vi.fn(),
      readChatSessionTurns: vi.fn(async () => persisted),
      writeChatSessionTurns
    }
    const session = new DesktopChatSession(boundary)
    const events: string[] = []
    session.subscribe((event) => events.push(event.type))

    const recovered = await session.restoreConversation('conversation-a')

    expect(recovered).toEqual([
      expect.objectContaining({ id: 'turn-interrupted', status: 'interrupted' })
    ])
    expect(writeChatSessionTurns).toHaveBeenCalledWith(
      'conversation-a',
      expect.arrayContaining([
        expect.objectContaining({ id: 'turn-interrupted', status: 'interrupted' })
      ])
    )
    expect(events).toContain('interrupted')
  })

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
    await session.restoreConversation('conversation-a', [
      {
        id: 'turn-a',
        conversationId: 'conversation-a',
        projectId: 'project-a',
        userMessage: { role: 'user', content: 'Question turn-a' },
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
      invalidationAnchor: { messageId: 'user-a', keepAnchor: true }
    })

    expect(result.turn.status).toBe('completed')
    expect(result.response.answer).toBe('Updated answer')
    expect(boundary.truncateRagMessages).toHaveBeenCalledWith('conversation-a', {
      messageId: 'user-a',
      keepAnchor: true
    })
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
      invalidationAnchor: { messageId: 'user-a', keepAnchor: false },
      userPersistence: { content: 'Edited question' }
    })

    expect(edited.turn.userMessage).toEqual({ role: 'user', content: 'Edited question' })
    expect(boundary.truncateRagMessages).toHaveBeenCalledWith('conversation-a', {
      messageId: 'user-a',
      keepAnchor: false
    })
    expect(boundary.addRagMessage).toHaveBeenCalledWith(
      'conversation-a',
      'user',
      'Edited question',
      { chatTurnId: 'turn-a' }
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
        toolCalls: [
          {
            name: 'generate_image',
            result: 'Image generation started - it will appear in the chat.',
            status: 'pending' as const
          }
        ],
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
    expect(result.response.toolCalls).toEqual([
      {
        name: 'generate_image',
        result: 'Image created and added to the chat.',
        status: 'completed'
      }
    ])
    expect(result.turn.responseMessages?.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'I made the image.'
    })
  })

  it('keeps a deferred image failure as the terminal tool outcome', async () => {
    const boundary: DesktopChatSessionBoundary = {
      ragChat: vi.fn(async () => ({ answer: '' })),
      toolChat: vi.fn(async () => ({
        answer: 'I tried to make the image.',
        toolCalls: [
          {
            name: 'generate_image',
            result: 'Image generation started - it will appear in the chat.',
            status: 'pending' as const
          }
        ],
        imageRequests: [{ prompt: 'A green bicycle' }]
      })),
      generateImage: vi.fn(async () => {
        throw new Error('Native image process exited')
      }),
      onRagStream: () => () => undefined,
      cancelRag: vi.fn()
    }
    const session = new DesktopChatSession(boundary)

    const result = await session.send({
      ...input('turn-tool-image-failed'),
      kind: 'tools',
      connectors: false,
      allMemory: true,
      imageAvailable: true
    })

    expect(result.generatedImages).toEqual([])
    expect(result.response.toolCalls).toEqual([
      {
        name: 'generate_image',
        result: 'Image generation failed: Native image process exited',
        status: 'failed'
      }
    ])
    expect(result.turn.status).toBe('completed')
  })

  it('keeps cancellation distinct from a deferred image failure', async () => {
    let rejectImage = (error: Error): void => {
      throw error
    }
    const boundary: DesktopChatSessionBoundary = {
      ragChat: vi.fn(async () => ({ answer: '' })),
      toolChat: vi.fn(async () => ({
        answer: 'I started the image.',
        toolCalls: [
          {
            name: 'generate_image',
            result: 'Image generation started - it will appear in the chat.',
            status: 'pending' as const
          }
        ],
        imageRequests: [{ prompt: 'A green bicycle' }]
      })),
      generateImage: vi.fn(
        () =>
          new Promise<
            Awaited<ReturnType<NonNullable<DesktopChatSessionBoundary['generateImage']>>>
          >((_resolve, reject) => {
            rejectImage = reject
          })
      ),
      onRagStream: () => () => undefined,
      cancelRag: vi.fn(),
      cancelImageGen: vi.fn(() => rejectImage(new Error('Image generation cancelled')))
    }
    const session = new DesktopChatSession(boundary)
    const pending = session.send({
      ...input('turn-tool-image-cancelled'),
      kind: 'tools',
      connectors: false,
      allMemory: true,
      imageAvailable: true
    })

    await vi.waitFor(() => expect(boundary.generateImage).toHaveBeenCalledOnce())
    expect(session.stopConversation('conversation-a', 'User stopped generation')).toBe(1)
    const result = await pending

    expect(result.generatedImages).toEqual([])
    expect(result.response.toolCalls).toEqual([
      {
        name: 'generate_image',
        result: 'Image generation was cancelled.',
        status: 'cancelled'
      }
    ])
    expect(result.turn.status).toBe('stopped')
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

describe('DesktopChatSession reasoning routing', () => {
  function ragBoundary(): DesktopChatSessionBoundary {
    return {
      ragChat: vi.fn(async () => ({ answer: 'Routed answer' })),
      onRagStream: () => () => undefined,
      cancelRag: vi.fn()
    }
  }

  it('carries an enabled reasoning flag into the rag boundary and the durable turn request', async () => {
    const boundary = ragBoundary()
    const session = new DesktopChatSession(boundary)

    const result = await session.send({ ...input('turn-think'), thinking: true })

    expect(boundary.ragChat).toHaveBeenCalledWith(
      'Question turn-think',
      'All',
      [],
      'project-a',
      'conversation-a',
      false,
      'turn-think',
      true,
      []
    )
    expect(result.turn.request.request).toMatchObject({ reasoning: { enabled: true } })
  })

  it('does not enable reasoning in the rag boundary when thinking is off', async () => {
    const boundary = ragBoundary()
    const session = new DesktopChatSession(boundary)

    const result = await session.send({ ...input('turn-plain'), thinking: false })

    expect(boundary.ragChat).toHaveBeenCalledWith(
      'Question turn-plain',
      'All',
      [],
      'project-a',
      'conversation-a',
      false,
      'turn-plain',
      false,
      []
    )
    expect(result.turn.request.request).toMatchObject({ reasoning: { enabled: false } })
  })

  it('maps the reasoning flag onto the tool boundary thinking option', async () => {
    const boundary: DesktopChatSessionBoundary = {
      ...ragBoundary(),
      toolChat: vi.fn(async () => ({ answer: 'Tool answer', toolCalls: [] }))
    }
    const session = new DesktopChatSession(boundary)
    const tools = {
      kind: 'tools' as const,
      connectors: true,
      allMemory: false,
      imageAvailable: false
    }

    await session.send({ ...input('turn-tools-think'), ...tools, thinking: true })
    await session.send({ ...input('turn-tools-plain'), ...tools, thinking: false })

    expect(boundary.toolChat).toHaveBeenNthCalledWith(
      1,
      'Question turn-tools-think',
      [],
      expect.objectContaining({ streamId: 'turn-tools-think', thinking: true })
    )
    expect(boundary.toolChat).toHaveBeenNthCalledWith(
      2,
      'Question turn-tools-plain',
      [
        { role: 'user', content: 'Question turn-tools-think' },
        { role: 'assistant', content: 'Tool answer' }
      ],
      expect.objectContaining({ streamId: 'turn-tools-plain', thinking: false })
    )
  })

  it('sends the image payload to the image boundary without any reasoning request', async () => {
    const boundary: DesktopChatSessionBoundary = {
      ...ragBoundary(),
      generateImage: vi.fn(async () => ({
        dataUrl: 'data:image/png;base64,cG5n',
        path: '/generated/dawn.png',
        syncId: 'dawn-sync-id',
        seed: 7,
        model: 'DreamShaper'
      }))
    }
    const session = new DesktopChatSession(boundary)

    const result = await session.send({
      ...input('turn-image-only'),
      kind: 'image',
      thinking: true,
      request: {
        prompt: 'A cabin at dawn',
        negativePrompt: 'blurry',
        width: 512,
        height: 768,
        steps: 20,
        cfgScale: 7,
        seed: 7,
        conversationId: 'conversation-a',
        projectId: 'project-a'
      }
    })

    expect(boundary.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'A cabin at dawn', conversationId: 'conversation-a' })
    )
    expect(boundary.ragChat).not.toHaveBeenCalled()
    expect(result.turn.request.operation).toMatchObject({
      type: 'image',
      prompt: 'A cabin at dawn',
      negativePrompt: 'blurry',
      width: 512,
      height: 768,
      steps: 20,
      guidanceScale: 7,
      seed: 7
    })
    expect(result.turn.request.request).not.toHaveProperty('reasoning')
  })

  it('merges the durable user context with the turn id instead of replacing it', async () => {
    const boundary: DesktopChatSessionBoundary = {
      ...ragBoundary(),
      addRagMessage: vi.fn(async () => ({ id: 3, uuid: 'user-3' }))
    }
    const session = new DesktopChatSession(boundary)

    await session.send({
      ...input('turn-ctx'),
      userPersistence: {
        content: 'Question turn-ctx',
        context: { source: 'voice', attachments: ['a.png'] }
      }
    })

    expect(boundary.addRagMessage).toHaveBeenCalledWith(
      'conversation-a',
      'user',
      'Question turn-ctx',
      { source: 'voice', attachments: ['a.png'], chatTurnId: 'turn-ctx' }
    )
  })
})

describe('DesktopChatSession context compaction', () => {
  it('compacts on a full window, keeps the turn, and continues with the compacted history', async () => {
    const histories: Array<Array<{ role: string; content: string }>> = []
    let calls = 0
    const boundary: DesktopChatSessionBoundary = {
      ragChat: vi.fn(async (_query, _app, history) => {
        histories.push(history)
        calls += 1
        if (calls === 1) {
          throw new Error(
            "Error invoking remote method 'rag:chat': Error: The request is larger than the model’s context window — usually too many connectors enabled at once."
          )
        }
        return { answer: 'Continued answer', context: { sources: [] } }
      }),
      onRagStream: vi.fn(() => () => undefined),
      cancelRag: vi.fn(),
      generateText: vi.fn(async () => 'What was said before'),
      getLlmSettings: vi.fn(async () => ({ ctxSize: 2048, effectiveCtxSize: 2048 }))
    }
    const session = new DesktopChatSession(boundary)
    const events: string[] = []
    session.subscribe((event) => events.push(event.type))
    const long = Array.from({ length: 12 }, (_, index) => ({
      id: `t${index}`,
      conversationId: 'conversation-c',
      userMessage: { role: 'user' as const, content: `Question ${index} ${'x'.repeat(600)}` },
      responseMessages: [
        { role: 'assistant' as const, content: `Answer ${index} ${'y'.repeat(600)}` }
      ],
      status: 'completed' as const,
      request: { operation: { type: 'text' as const }, request: {} }
    }))
    await session.restoreConversation('conversation-c', long)

    const result = await session.send(input('turn-c', 'conversation-c'))

    expect(result.turn.status).toBe('completed')
    expect(result.response.answer).toBe('Continued answer')
    expect(calls).toBe(2)
    expect(events).toContain('compacted')
    expect(boundary.generateText).toHaveBeenCalledTimes(1)
    expect(histories[1]!.some((turn) => turn.content.includes('What was said before'))).toBe(true)
    expect(histories[1]!.length).toBeLessThan(histories[0]!.length)
  })

  it('still compacts with the default window when the llama settings lookup fails', async () => {
    let calls = 0
    const boundary: DesktopChatSessionBoundary = {
      ragChat: vi.fn(async () => {
        calls += 1
        if (calls === 1) throw new Error('the request exceeds the available context size')
        return { answer: 'Continued after default window', context: { sources: [] } }
      }),
      onRagStream: vi.fn(() => () => undefined),
      cancelRag: vi.fn(),
      generateText: vi.fn(async () => 'Earlier summary'),
      getLlmSettings: vi.fn(async () => {
        throw new Error('llama-server is not running')
      })
    }
    const session = new DesktopChatSession(boundary)
    const events: string[] = []
    session.subscribe((event) => events.push(event.type))
    const long = Array.from({ length: 24 }, (_, index) => ({
      id: `t${index}`,
      conversationId: 'conversation-e',
      userMessage: { role: 'user' as const, content: `Question ${index} ${'x'.repeat(600)}` },
      responseMessages: [
        { role: 'assistant' as const, content: `Answer ${index} ${'y'.repeat(600)}` }
      ],
      status: 'completed' as const,
      request: { operation: { type: 'text' as const }, request: {} }
    }))
    await session.restoreConversation('conversation-e', long)

    const result = await session.send(input('turn-e', 'conversation-e'))

    expect(boundary.getLlmSettings).toHaveBeenCalledTimes(1)
    expect(result.response.answer).toBe('Continued after default window')
    expect(calls).toBe(2)
    expect(events).toContain('compacted')
    expect(boundary.generateText).toHaveBeenCalledTimes(1)
  })

  it('surfaces the original error when the window is full but Desktop cannot compact', async () => {
    const boundary: DesktopChatSessionBoundary = {
      ragChat: vi.fn(async () => {
        throw new Error('the request exceeds the available context size')
      }),
      onRagStream: vi.fn(() => () => undefined),
      cancelRag: vi.fn()
    }
    const session = new DesktopChatSession(boundary)
    await expect(session.send(input('turn-d', 'conversation-d'))).rejects.toThrow(/context size/)
    expect(boundary.ragChat).toHaveBeenCalledTimes(1)
  })
})

describe('DesktopChatSession model fallback', () => {
  it('publishes the shared fallback event and names the model that answered', async () => {
    let streamListener: ((event: DesktopChatStreamEvent) => void) | undefined
    const failed = { ...DESKTOP_CHAT_ROUTE, id: 'gemma', name: 'Gemma 4' }
    const next = { ...DESKTOP_CHAT_ROUTE, id: 'qwen', name: 'Qwen 3.5' }
    const boundary: DesktopChatSessionBoundary = {
      ragChat: vi.fn(async (...args: unknown[]) => {
        const streamId = args[6] as string
        streamListener?.({
          streamId,
          type: 'fallback',
          fallback: { failed, next, reason: 'it ran out of memory' }
        })
        return { answer: 'Fallback answer', context: { sources: [] }, model: next }
      }),
      onRagStream: vi.fn((listener) => {
        streamListener = listener
        return () => undefined
      }),
      cancelRag: vi.fn()
    }
    const session = new DesktopChatSession(boundary)
    const fallbacks: Array<{ failed: string; next: string }> = []
    session.subscribe((event) => {
      if (event.type === 'fallback') fallbacks.push({ failed: event.failed.name, next: event.next.name })
    })

    const result = await session.send(input('turn-f'))

    expect(fallbacks).toEqual([{ failed: 'Gemma 4', next: 'Qwen 3.5' }])
    expect(result.turn.result?.model.name).toBe('Qwen 3.5')
  })
})
