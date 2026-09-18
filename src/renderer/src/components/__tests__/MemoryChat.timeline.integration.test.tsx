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
  step?:
  | { kind: 'running_tool'; name: string }
  | { kind: 'model_changed'; failed: string; next: string }
  call?: { name: string; result: string; status: 'completed' }
}

function chatBoundary(
  savedReply?: { content: string; context: unknown },
  voiceMode = false,
  showGenerationDetails = false,
  options?: {
    userContext?: unknown
    imageJob?: unknown
    activeStreams?: unknown[]
    agentic?: boolean
  }
): {
  status: () => { streamId: string; messages: string[]; voice: string; syntheses: string[] }
  emit: (event: Omit<Event, 'streamId'>) => void
  finish: (modelName?: string) => void
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
        context: options?.userContext,
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
  let voice = 'af_heart'
  const syntheses: string[] = []
  const api = {
    isPro: false,
    imageGenStatus: async () => ({ available: false, models: [], active: '' }),
    onImageGenProgress: () => () => { },
    getRagConversations: async () => [conversation],
    getRagConversation: async () => conversation,
    getRagMessages: async () => messages.map((message) => ({ ...message })),
    getActiveRagStreams: async () => options?.activeStreams ?? [],
    onImageGenJobState: () => () => { },
    onImageGenConversationUpdated: () => () => { },
    imageGenJobStatus: async () => ({ id: null, phase: 'idle' as const, conversationId: null, projectId: null, stage: null, enhancedPrompt: '', progress: null, outputPath: null, error: null, startedAt: null, finishedAt: null }),
    ...(options?.imageJob ? { imageGenJobStatus: async () => options.imageJob } : {}),
    onRagStream: (callback: (event: Event) => void) => {
      onStream = callback
      return () => {
        onStream = undefined
      }
    },
    onRagConversationsChanged: () => () => { },
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
      composerConnectorsOn: options?.agentic === true,
      composerVoiceMode: voiceMode,
      showGenerationDetails,
      ttsVoice: voice
    }),
    saveSetting: async (key: string, value: unknown) => {
      if (key === 'ttsVoice' && typeof value === 'string') voice = value
    },
    ttsVoices: async () => [
      { id: 'af_heart', label: 'Heart', language: 'en-US' },
      { id: 'am_michael', label: 'Michael', language: 'en-US' }
    ],
    onTtsVoiceProgress: () => () => { },
    prepareTtsVoice: async () => ({ ready: true }),
    getLlmSettings: async () => ({ ctxSize: 4096 }),
    listTools: async () => [],
    mcpList: async () => [],
    listProjects: async () => [],
    listSkills: async () => [],
    styleThumbs: async () => ({}),
    speak: async (_text: string, requestedVoice?: string) => {
      const selectedVoice = requestedVoice ?? voice
      syntheses.push(selectedVoice)
      return { dataUrl: `data:audio/wav;base64,${btoa(selectedVoice)}` }
    },
    tasks: { list: async () => [], onChanged: () => () => { } },
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
    ; (window as unknown as { api: unknown }).api = api
  return {
    status: () => ({
      streamId,
      messages: messages.map((message) => message.content),
      voice,
      syntheses
    }),
    emit: (event) => onStream?.({ ...event, streamId }),
    finish: (modelName) =>
      finishTurn?.({
        answer: 'The answer is ready.',
        metrics: modelName ? { modelName } : undefined,
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

async function openCompletedWork(): Promise<void> {
  const toggle = (await screen.findAllByRole('button', { name: 'Work done' })).at(-1)
  if (toggle?.getAttribute('data-state') === 'closed') await userEvent.click(toggle)
}

afterEach(cleanup)

describe('<MemoryChat/> ordered tool turn', () => {
  it('keeps synced input and generated images visible when the user switches to voice mode', async () => {
    ; (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => { }
    chatBoundary(
      {
        content:
          '<think>__LABEL:Enhanced prompt__\nA majestic horse at sunset.</think>\n\nGenerated for: a horse',
        context: {
          reasoning: 'A majestic horse at sunset.',
          reasoningLabel: 'Enhanced prompt',
          timeline: [
            { kind: 'thinking', text: 'Plan the image request.' },
            { kind: 'tool', toolIndex: 0 },
            { kind: 'thinking', text: 'Confirm the image request.' }
          ],
          toolCalls: [
            {
              name: 'generate_image',
              result: 'Created the requested image.',
              status: 'completed'
            }
          ],
          imageRef: { id: 'horse-image', path: '/received/horse.png' }
        }
      },
      false,
      false,
      {
        userContext: {
          attachments: [
            {
              id: 'input-image',
              name: 'synced-input.jpg',
              kind: 'image',
              path: '/received/synced-input.jpg'
            },
            {
              id: 'input-audio',
              name: 'synced-input.wav',
              kind: 'audio',
              path: '/received/synced-input.wav'
            }
          ]
        }
      }
    )
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <MemoryChat openTarget={{ conversationId: 'timeline-chat' }} />
      </TooltipProvider>
    )

    expect(await screen.findByAltText('synced-input.jpg')).toBeTruthy()
    expect(await screen.findByAltText('Generated')).toBeTruthy()
    await openCompletedWork()
    expect(timelineLabels().map((label) => label.split('Created the requested image.')[0])).toEqual([
      'Thought process',
      'Generated image',
      'Thought process',
      'Enhanced prompt'
    ])

    await user.click(screen.getByRole('button', { name: 'Voice' }))

    expect(await screen.findByRole('group', { name: 'Voice mode' })).toBeTruthy()
    expect(screen.getByAltText('synced-input.jpg')).toBeTruthy()
    expect(screen.getByAltText('Generated')).toBeTruthy()
    expect(screen.getByText('Generated for: a horse')).toBeTruthy()
    expect(screen.getAllByTitle('Play')).toHaveLength(2)
    await openCompletedWork()
    expect(timelineLabels().map((label) => label.split('Created the requested image.')[0])).toEqual([
      'Thought process',
      'Generated image',
      'Thought process',
      'Enhanced prompt'
    ])
  })

  it('keeps enhanced prompt and active image progress in the timeline before its footer', async () => {
    ; (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => { }
    chatBoundary(
      {
        content: '',
        context: {
          reasoning: 'Prepare the image request.',
          timeline: [
            { kind: 'thinking', text: 'Prepare the image request.' },
            { kind: 'tool', toolIndex: 0 }
          ],
          toolCalls: [
            {
              name: 'generate_image',
              result: 'Image generation started.',
              status: 'completed'
            }
          ],
          toolsOffered: ['generate_image'],
          metrics: { totalSeconds: 2.4 }
        }
      },
      false,
      true,
      {
        imageJob: {
          id: 'image-job',
          phase: 'running',
          conversationId: 'timeline-chat',
          projectId: null,
          stage: 'sampling',
          enhancedPrompt: 'A detailed image prompt.',
          progress: { step: 4, total: 17, secPerStep: 1 },
          outputPath: null,
          error: null,
          startedAt: 1,
          finishedAt: null
        }
      }
    )
    render(
      <TooltipProvider>
        <MemoryChat openTarget={{ conversationId: 'timeline-chat' }} />
      </TooltipProvider>
    )

    const progress = await screen.findByText('Generating image · Step 4 of 17')
    expect(timelineLabels()).toEqual([
      'Thought process',
      expect.stringContaining('Generated image'),
      'Enhanced prompt'
    ])
    expect(screen.queryByRole('button', { name: 'Tools sent in request (1)' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Generation details' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Working' }).getAttribute('data-state')).toBe('open')
    expect(progress).toBeTruthy()
    expect(screen.getAllByText('Off Grid AI')).toHaveLength(1)
  })

  it('replaces failed model text with the new answer and keeps the model-change row after reload', async () => {
    ; (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => { }
    const boundary = chatBoundary(undefined, false, true, { agentic: true })
    const user = userEvent.setup()
    const chat = render(
      <TooltipProvider>
        <MemoryChat openTarget={{ conversationId: 'timeline-chat' }} />
      </TooltipProvider>
    )

    await screen.findByText('Earlier question')
    const composer = await screen.findByPlaceholderText(/^ask /i)
    fireEvent.change(composer, { target: { value: 'Answer this' } })
    await user.click(screen.getByRole('button', { name: /^send$/i }))
    await waitFor(() => expect(boundary.status().streamId).not.toBe(''))

    await act(async () => {
      boundary.emit({ type: 'content', text: 'Failed route partial.' })
      boundary.emit({ type: 'reasoning', text: 'Failed route thought.' })
      boundary.emit({
        type: 'step',
        step: {
          kind: 'model_changed',
          failed: 'First model',
          next: 'Backup model'
        }
      })
      boundary.emit({ type: 'content', text: 'The answer is ready.' })
      boundary.finish('Backup model')
    })

    expect(await screen.findByText('The answer is ready.')).toBeTruthy()
    expect(
      screen.getByText('Model changed: First model could not answer. Backup model is answering.')
    ).toBeTruthy()
    await user.click(await screen.findByRole('button', { name: 'Generation details' }))
    expect(screen.getByText(/Model: Backup model/)).toBeTruthy()
    expect(screen.queryByText('Failed route partial.')).toBeNull()
    expect(screen.queryByText('Failed route thought.')).toBeNull()

    chat.unmount()
    render(
      <TooltipProvider>
        <MemoryChat openTarget={{ conversationId: 'timeline-chat' }} />
      </TooltipProvider>
    )
    expect(await screen.findByText('The answer is ready.')).toBeTruthy()
    expect(
      screen.getByText('Model changed: First model could not answer. Backup model is answering.')
    ).toBeTruthy()
    await user.click(await screen.findByRole('button', { name: 'Generation details' }))
    expect(screen.getByText(/Model: Backup model/)).toBeTruthy()
    expect(screen.queryByText('Failed route partial.')).toBeNull()
  })

  it('interleaves reasoning with tools live and keeps the same completed timeline after reload', async () => {
    ; (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => { }
    const boundary = chatBoundary(undefined, false, false, { agentic: true })
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
    expect(screen.getByRole('button', { name: 'Work done' }).getAttribute('data-state')).toBe(
      'closed'
    )

    chat.unmount()
    render(
      <TooltipProvider>
        <MemoryChat openTarget={{ conversationId: 'timeline-chat' }} />
      </TooltipProvider>
    )
    expect(await screen.findByText('The answer is ready.')).toBeTruthy()
    await openCompletedWork()
    expect(timelineLabels()).toEqual([
      'Thought process',
      expect.stringContaining('Searched the web'),
      'Thought process',
      expect.stringContaining('Read web page')
    ])
    expect(screen.queryByText('Thinking…')).toBeNull()
  })

  it('keeps the existing layout for saved replies without an ordered timeline', async () => {
    ; (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => { }
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
    await openCompletedWork()
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
      ; (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => { }
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

      await openCompletedWork()
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
    ; (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => { }
    chatBoundary(
      {
        content: 'The answer is ready.',
        context: {
          toolsOffered: ['web_search', 'read_url'],
          metrics: {
            promptTokens: 2888,
            contextWindowTokens: 12288,
            decodeTokensPerSecond: 42.5,
            completionTokens: 567,
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
    expect(screen.queryByTestId('generation-metrics')).toBeNull()
    await userEvent.click(
      await screen.findByRole('button', { name: 'Tools sent in request (2)' })
    )
    expect(screen.getByText('web_search')).toBeTruthy()
    await userEvent.click(await screen.findByRole('button', { name: 'Generation details' }))
    expect(screen.queryByText('web_search')).toBeNull()
    expect(
      await screen.findByText(
        /Context: 24% used \(2888 prompt tokens \/ 12288 context\) · 42\.5 tok\/s · 567 output tokens · 3\.4s total/
      )
    ).toBeTruthy()
  })

  it('plays an existing voice reply with the newly selected voice, then caches that voice', async () => {
    ; (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => { }
    const boundary = chatBoundary({ content: 'The answer is ready.', context: {} }, true)
    const playedSources: string[] = []
    const originalAudio = globalThis.Audio
    class PlaybackDevice {
      paused = true
      currentTime = 0
      duration = 3
      playbackRate = 1
      onended: (() => void) | null = null

      constructor(public src: string) { }

      async play(): Promise<void> {
        playedSources.push(this.src)
        this.paused = false
      }

      pause(): void {
        this.paused = true
      }
    }
    globalThis.Audio = PlaybackDevice as unknown as typeof Audio

    try {
      const user = userEvent.setup()
      render(
        <TooltipProvider>
          <MemoryChat openTarget={{ conversationId: 'timeline-chat' }} />
        </TooltipProvider>
      )
      await screen.findByText('The answer is ready.')
      const replyPlayback = screen.getAllByTitle('Play').at(-1)!
      await user.click(replyPlayback)
      await waitFor(() =>
        expect(playedSources).toEqual([`data:audio/wav;base64,${btoa('af_heart')}`])
      )
      await user.click(replyPlayback) // pause
      await user.click(replyPlayback) // resume the same sound
      expect(boundary.status().syntheses).toEqual(['af_heart'])
      await user.click(replyPlayback) // pause before changing voice

      await user.click(screen.getByTitle('Settings'))
      await user.click(screen.getByRole('button', { name: 'voice' }))
      const voiceSelect = await screen.findByRole('button', { name: 'Voice selection' })
      await waitFor(() => expect((voiceSelect as HTMLButtonElement).disabled).toBe(false))
      voiceSelect.focus()
      await user.keyboard('{Enter}')
      expect(voiceSelect.getAttribute('aria-expanded')).toBe('true')
      expect(screen.queryAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
        'Heart',
        'Michael'
      ])
      await user.click(await screen.findByRole('menuitemradio', { name: 'Michael' }))
      await waitFor(() => expect(boundary.status().voice).toBe('am_michael'))
      await user.click(screen.getByRole('button', { name: 'Close' }))
      await user.click(replyPlayback)
      await waitFor(() =>
        expect(playedSources.at(-1)).toBe(`data:audio/wav;base64,${btoa('am_michael')}`)
      )
      expect(boundary.status().syntheses).toEqual(['af_heart', 'am_michael'])
      await user.click(replyPlayback) // pause
      await user.click(replyPlayback) // reuse the new sound
      expect(boundary.status().syntheses).toEqual(['af_heart', 'am_michael'])
    } finally {
      globalThis.Audio = originalAudio
    }
  })

  it('keeps a failed memory search readable when a later search found sources', async () => {
    ; (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => { }
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

    await userEvent.click(await screen.findByRole('button', { name: 'Work failed' }))
    const failed = await screen.findByRole('button', { name: 'Searched memory, failed' })
    await userEvent.click(failed)
    expect(await screen.findByText('Error: memory index unavailable')).toBeTruthy()
    await userEvent.click(
      screen.getByRole('button', { name: 'Searched your memory — 1 result, complete' })
    )
    expect(await screen.findByRole('button', { name: /Release decision/ })).toBeTruthy()
  })
})
