// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryChat } from '../MemoryChat'
import { TooltipProvider } from '../ui/tooltip'

type Event = {
  streamId: string
  type: 'reasoning' | 'content' | 'step' | 'tool_result'
  text?: string
  step?: { kind: 'running_tool'; name: string }
  call?: { name: string; result: string; status: 'completed' }
}

function chatBoundary(
  savedReply?: { content: string; context: unknown },
  voiceMode = false,
  showGenerationDetails = false
): {
  status: () => { streamId: string; messages: string[] }
  emit: (event: Omit<Event, 'streamId'>) => void
  finish: () => void
} {
  const conversation = {
    id: 'timeline-chat',
    title: 'Timeline chat',
    project_id: null,
    created_at: '2026-09-13 09:00:00',
    updated_at: '2026-09-13 09:00:00',
    message_count: savedReply ? 2 : 1
  }
  const messages: Array<{
    id: string
    uuid: string
    role: 'user' | 'assistant'
    content: string
    context?: unknown
    created_at: string
  }> = [
    {
      id: 'earlier-message',
      uuid: 'earlier-message',
      role: 'user',
      content: 'Earlier question',
      created_at: '2026-09-13 09:00:00'
    },
    ...(savedReply
      ? [
          {
            id: 'saved-reply',
            uuid: 'saved-reply',
            role: 'assistant' as const,
            content: savedReply.content,
            context: savedReply.context,
            created_at: '2026-09-13 09:00:01'
          }
        ]
      : [])
  ]
  let streamId = ''
  let onStream: ((event: Event) => void) | undefined
  let finishTurn: ((result: unknown) => void) | undefined
  let nextId = 2
  const api = {
    isPro: false,
    imageGenStatus: async () => ({ available: false, models: [], active: '' }),
    onImageGenProgress: () => () => {},
    getRagConversations: async () => [conversation],
    getRagConversation: async () => conversation,
    getRagMessages: async () => messages.map((message) => ({ ...message })),
    getActiveRagStreams: async () => [],
    onRagStream: (callback: (event: Event) => void) => {
      onStream = callback
      return () => {
        onStream = undefined
      }
    },
    onRagConversationsChanged: () => () => {},
    addRagMessage: async (
      _conversationId: string,
      role: 'user' | 'assistant',
      content: string,
      context?: unknown
    ) => {
      const id = nextId++
      const uuid = `timeline-message-${id}`
      messages.push({
        id: uuid,
        uuid,
        role,
        content,
        context,
        created_at: `2026-09-13 09:00:${String(id).padStart(2, '0')}`
      })
      conversation.message_count = messages.length
      return { id, uuid }
    },
    getSettings: async () => ({
      composerToolsOn: true,
      composerVoiceMode: voiceMode,
      showGenerationDetails
    }),
    getLlmSettings: async () => ({ ctxSize: 4096 }),
    listTools: async () => [],
    mcpList: async () => [],
    listProjects: async () => [],
    listSkills: async () => [],
    styleThumbs: async () => ({}),
    speak: async () => ({ dataUrl: '' }),
    tasks: { list: async () => [], onChanged: () => () => {} },
    toolChat: async (_query: string, _history: unknown[], options: { streamId: string }) => {
      streamId = options.streamId
      return new Promise((resolve) => {
        finishTurn = resolve
      })
    },
    ragChat: async () => {
      throw new Error('The tool turn used the memory-chat path')
    }
  }
  ;(window as unknown as { api: unknown }).api = api
  return {
    status: () => ({ streamId, messages: messages.map((message) => message.content) }),
    emit: (event) => onStream?.({ ...event, streamId }),
    finish: () =>
      finishTurn?.({
        answer: 'The answer is ready.',
        toolCalls: [
          { name: 'web_search', result: 'Search results', status: 'completed' },
          { name: 'read_url', result: 'Page content', status: 'completed' }
        ],
        unified: [],
        imageRequests: []
      })
  }
}

function timelineLabels(): string[] {
  const timeline = screen.getByRole('list', { name: 'Thinking and tool calls' })
  return Array.from(timeline.children).map(
    (row) =>
      within(row as HTMLElement)
        .getByRole('button')
        .textContent?.trim() ?? ''
  )
}

afterEach(cleanup)

describe('<MemoryChat/> ordered tool turn', () => {
  it('interleaves reasoning with tools live and keeps the same completed timeline after reload', async () => {
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
    const boundary = chatBoundary()
    const user = userEvent.setup()
    const chat = render(
      <TooltipProvider>
        <MemoryChat openTarget={{ conversationId: 'timeline-chat' }} />
      </TooltipProvider>
    )

    await screen.findByText('Earlier question')
    const composer = await screen.findByPlaceholderText(/^ask /i)
    fireEvent.change(composer, { target: { value: 'Find the source and read it' } })
    await user.click(screen.getByRole('button', { name: /^send$/i }))
    await waitFor(() => expect(boundary.status().streamId).not.toBe(''))

    await act(async () => {
      boundary.emit({ type: 'reasoning', text: 'First thought.' })
      boundary.emit({ type: 'step', step: { kind: 'running_tool', name: 'web_search' } })
      boundary.emit({
        type: 'tool_result',
        call: { name: 'web_search', result: 'Search results', status: 'completed' }
      })
      boundary.emit({ type: 'reasoning', text: 'Second thought.' })
    })
    expect(timelineLabels()).toEqual([
      'Thought process',
      expect.stringContaining('Searched the web'),
      'Thinking…'
    ])

    await act(async () => {
      boundary.emit({ type: 'step', step: { kind: 'running_tool', name: 'read_url' } })
      boundary.emit({
        type: 'tool_result',
        call: { name: 'read_url', result: 'Page content', status: 'completed' }
      })
      boundary.emit({ type: 'content', text: 'The answer is ready.' })
    })
    expect(timelineLabels()).toEqual([
      'Thought process',
      expect.stringContaining('Searched the web'),
      'Thought process',
      expect.stringContaining('Read web page')
    ])

    await act(async () => boundary.finish())
    expect(await screen.findByText('The answer is ready.')).toBeTruthy()
    expect(screen.queryByText('Thinking…')).toBeNull()

    chat.unmount()
    render(
      <TooltipProvider>
        <MemoryChat openTarget={{ conversationId: 'timeline-chat' }} />
      </TooltipProvider>
    )
    expect(await screen.findByText('The answer is ready.')).toBeTruthy()
    expect(timelineLabels()).toEqual([
      'Thought process',
      expect.stringContaining('Searched the web'),
      'Thought process',
      expect.stringContaining('Read web page')
    ])
    expect(screen.queryByText('Thinking…')).toBeNull()
  })

  it('keeps the existing layout for saved replies without an ordered timeline', async () => {
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
    chatBoundary({
      content: 'An older answer.',
      context: {
        reasoning: 'Older reasoning.',
        toolCalls: [
          { name: 'web_search', result: 'Search results', status: 'completed' },
          { name: 'read_url', result: 'Page content', status: 'completed' }
        ]
      }
    })
    render(
      <TooltipProvider>
        <MemoryChat openTarget={{ conversationId: 'timeline-chat' }} />
      </TooltipProvider>
    )

    expect(await screen.findByText('An older answer.')).toBeTruthy()
    expect(timelineLabels()).toEqual([
      'Thought process',
      expect.stringContaining('Searched the web'),
      expect.stringContaining('Read web page')
    ])
    expect(screen.queryByText('Thinking…')).toBeNull()
  })

  it.each([false, true])(
    'shows memory source cards inside the tool row without a second search section (voice mode: %s)',
    async (voiceMode) => {
      ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
      chatBoundary(
        {
          content: 'The release is planned for Friday. [S1]',
          context: {
            reasoning: 'Check the source.',
            timeline: [
              { kind: 'thinking', text: 'Check the source.' },
              { kind: 'tool', toolIndex: 0 }
            ],
            toolCalls: [
              { name: 'search_memory', result: 'Raw memory result from a private page.' }
            ],
            unified: [
              {
                key: 'chat:release-decision',
                kind: 'chat',
                refId: 1,
                title: 'Release decision',
                snippet: 'The release is planned for Friday.',
                surface: 'Chat',
                url: 'release-decision',
                ts: Date.UTC(2026, 8, 12),
                score: 1
              }
            ]
          }
        },
        voiceMode
      )
      render(
        <TooltipProvider>
          <MemoryChat openTarget={{ conversationId: 'timeline-chat' }} />
        </TooltipProvider>
      )

      const search = await screen.findByRole('button', {
        name: 'Searched your memory — 1 result, complete'
      })
      expect(screen.getAllByText(/Searched your memory — 1 result/)).toHaveLength(1)
      await userEvent.click(search)
      expect(await screen.findByRole('button', { name: /Release decision/ })).toBeTruthy()
      expect(screen.queryByText('Raw memory result from a private page.')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Searched your memory — 1 results' })).toBeNull()
    }
  )

  it('shows saved generation details below a voice reply when enabled', async () => {
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
    chatBoundary(
      {
        content: 'The answer is ready.',
        context: {
          metrics: {
            estimatedPromptTokens: 1024,
            contextWindowTokens: 4096,
            decodeTokensPerSecond: 42.5,
            completionTokens: 128,
            totalSeconds: 3.4
          }
        }
      },
      true,
      true
    )
    render(
      <TooltipProvider>
        <MemoryChat openTarget={{ conversationId: 'timeline-chat' }} />
      </TooltipProvider>
    )

    expect(await screen.findByText('The answer is ready.')).toBeTruthy()
    expect(
      await screen.findByText(/Context: ~25% used · 42\.5 tok\/s · 128 tokens · 3\.4s total/)
    ).toBeTruthy()
  })

  it('keeps a failed memory search readable when a later search found sources', async () => {
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
    chatBoundary({
      content: 'The release is planned for Friday. [S1]',
      context: {
        timeline: [
          { kind: 'tool', toolIndex: 0 },
          { kind: 'tool', toolIndex: 1 }
        ],
        toolCalls: [
          { name: 'search_memory', result: 'Error: memory index unavailable', status: 'failed' },
          {
            name: 'search_memory',
            result: 'The release is planned for Friday.',
            status: 'completed'
          }
        ],
        unified: [
          {
            key: 'chat:release-decision',
            kind: 'chat',
            refId: 1,
            title: 'Release decision',
            snippet: 'The release is planned for Friday.',
            surface: 'Chat',
            url: 'release-decision',
            ts: Date.UTC(2026, 8, 12),
            score: 1
          }
        ]
      }
    })
    render(
      <TooltipProvider>
        <MemoryChat openTarget={{ conversationId: 'timeline-chat' }} />
      </TooltipProvider>
    )

    const failed = await screen.findByRole('button', { name: 'Searched memory, failed' })
    await userEvent.click(failed)
    expect(await screen.findByText('Error: memory index unavailable')).toBeTruthy()
    await userEvent.click(
      screen.getByRole('button', { name: 'Searched your memory — 1 result, complete' })
    )
    expect(await screen.findByRole('button', { name: /Release decision/ })).toBeTruthy()
  })
})
