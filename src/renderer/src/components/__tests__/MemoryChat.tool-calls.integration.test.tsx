// @vitest-environment jsdom

// Integration: tool calls persist on an assistant message and are readable. A message
// loaded with context.toolCalls renders each call as an inline disclosure; expanding it keeps
// the full result in the conversation instead of opening a separate viewer.
// Real MemoryChat through the chat-boundary harness; only the window.api seam is faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatBoundary, installBoundary, renderChat, send } from './harness/chat-boundary'
import { resetTaskSessionStoreForTests } from '@renderer/lib/task-session-store'
import {
  closeTaskWorkspace,
  onOpenTaskSidePanel,
  type OpenTaskPanelRequest
} from '@renderer/lib/task-side-panel'

const LONG_RESULT =
  'GitHub — off-grid-ai/OGAD: Off Grid AI Desktop, a local-first on-device AI runtime.'

describe('<MemoryChat/> tool calls — persistent + inline', () => {
  beforeEach(() => {
    resetTaskSessionStoreForTests()
    closeTaskWorkspace()
    ;(Element.prototype as unknown as { scrollIntoView(): void }).scrollIntoView = () => {}
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      cb(0)
      return 1
    }
  })
  afterEach(() => {
    cleanup()
    closeTaskWorkspace()
    resetTaskSessionStoreForTests()
    vi.unstubAllGlobals()
  })

  it('opens a persisted Web Use work card on its exact task detail', async () => {
    const boundary = new ChatBoundary()
    boundary.messages['conversation-b'] = [
      {
        id: 1,
        role: 'assistant',
        content: 'The research is ready.',
        context: {
          unified: [],
          toolCalls: [
            {
              name: 'web_use',
              status: 'completed',
              result: 'Task reference: memory-web-task.'
            }
          ]
        }
      }
    ]
    installBoundary(boundary)
    window.api.tasks = {
      list: vi.fn(async () => [
        {
          taskId: 'memory-web-task',
          kind: 'web_use' as const,
          title: 'Research suppliers',
          status: 'done' as const,
          steps: ['Saved the result'],
          startedAt: 1,
          updatedAt: 2
        }
      ]),
      retryAvailability: vi.fn(async () => ({ available: false })),
      retry: vi.fn(async () => ({ available: false })),
      guideAvailability: vi.fn(async () => ({ available: false })),
      guideTask: vi.fn(async () => ({ available: false, accepted: false })),
      onChanged: vi.fn(() => () => undefined)
    }
    const requests: OpenTaskPanelRequest[] = []
    const offOpen = onOpenTaskSidePanel((request) => requests.push(request))
    renderChat({ conversationId: 'conversation-b' })

    await userEvent.click(await screen.findByRole('button', { name: /Work done/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Web Use, complete' }))
    expect(requests.at(-1)).toEqual({
      taskId: 'memory-web-task',
      kind: 'web_use',
      detail: true
    })
    offOpen()
  })

  it('renders each tool call below its answer and expands the full result inline', async () => {
    const boundary = new ChatBoundary()
    // An assistant turn that already ran tools — persisted via context.toolCalls.
    boundary.messages['conversation-b'] = [
      {
        id: 1,
        role: 'assistant',
        content: 'Here is what I found.',
        context: {
          unified: [],
          toolCalls: [
            { name: 'web_search', result: LONG_RESULT },
            { name: 'read_url', result: '**Off Grid AI** · GitHub page body text' }
          ]
        }
      }
    ]
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-b' })

    const work = await screen.findByRole('button', { name: /Work done/ })
    const answer = await screen.findByText('Here is what I found.')
    expect(answer.compareDocumentPosition(work) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(screen.queryByText(LONG_RESULT)).toBeNull()

    // One timeline explains the turn. Each full result stays behind its own disclosure.
    await user.click(work)
    const chip = await screen.findByRole('button', { name: 'Searched the web, complete' })
    const markdownTool = await screen.findByRole('button', { name: 'Read web page, complete' })
    await user.click(chip)
    expect(await screen.findByText(LONG_RESULT)).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()

    await user.click(markdownTool)
    const boldToolResult = await screen.findByText('Off Grid AI', { selector: 'strong' })
    expect(boldToolResult.tagName).toBe('STRONG')
    expect(boldToolResult.style.fontWeight).toBe('700')
  })

  it('keeps a saved tool result closed until the user opens it', async () => {
    const boundary = new ChatBoundary()
    boundary.messages['conversation-b'] = [
      {
        id: 1,
        role: 'tool',
        content: LONG_RESULT,
        context: {
          unified: [],
          tool: { name: 'web_search', status: 'completed', durationMs: 1031 }
        }
      },
      {
        id: 2,
        role: 'tool',
        content: 'The selected page text.',
        context: {
          unified: [],
          tool: { name: 'read_url', status: 'completed', durationMs: 1696 }
        }
      }
    ]
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-b' })

    const work = await screen.findByRole('button', { name: /Work done/ })
    expect(work.textContent).toContain('2 steps · complete')
    expect(screen.queryByText(LONG_RESULT)).toBeNull()
    // Adjacent persisted tool messages are one assistant-turn timeline.
    expect(screen.getByTestId('chat-tool-timeline-1')).toBeTruthy()
    expect(screen.queryByTestId('chat-tool-timeline-2')).toBeNull()

    await user.click(work)
    const tool = await screen.findByRole('button', { name: 'Searched the web, complete' })
    expect(tool.textContent).toContain('1031 ms · complete')
    await user.click(tool)
    expect(await screen.findByText(LONG_RESULT)).toBeTruthy()
  })

  it('explains a persisted proposal run as one ordered customer timeline', async () => {
    const boundary = new ChatBoundary()
    boundary.messages['conversation-b'] = [
      {
        id: 1,
        role: 'assistant',
        content: 'Your proposal is ready for review.',
        context: {
          unified: [],
          toolCalls: [
            { name: 'list_folder', result: 'notes.md', status: 'completed' },
            { name: 'read_file', result: 'Private source material', status: 'completed' },
            {
              name: 'proposal_deck',
              arguments: '{"action":"save_skeleton"}',
              result: 'Slide plan saved.',
              status: 'completed'
            },
            { name: 'web_use', result: 'Research saved.', status: 'completed' },
            { name: 'generate_image', result: 'Image created.', status: 'completed' },
            { name: 'request_approval', result: '', status: 'cancelled' },
            { name: 'computer_use', result: 'Slides created.', status: 'completed' },
            { name: 'write_file', result: 'Deck saved.', status: 'completed' }
          ]
        }
      }
    ]
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-b' })

    const work = await screen.findByRole('button', { name: /Action needed/ })
    expect(work.textContent).toContain('8 steps · needs attention')
    if (work.getAttribute('aria-expanded') !== 'true') await user.click(work)
    const labels = [
      'Listed folder',
      'Read file',
      'Built slide plan',
      'Web Use',
      'Generated image',
      'Requested approval',
      'Computer Use',
      'Created output'
    ].map((label) => screen.getByText(label))
    for (let index = 1; index < labels.length; index += 1) {
      expect(
        labels[index - 1]!.compareDocumentPosition(labels[index]!) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).not.toBe(0)
    }
    expect(screen.getByText('Waiting for your attention.')).toBeTruthy()
  })

  it('renders assistant Markdown with visible document structure', async () => {
    const boundary = new ChatBoundary()
    boundary.messages['conversation-b'] = [
      {
        id: 1,
        role: 'assistant',
        content: '# Summary\n\n- **First item**\n- Second item\n\n> Important note',
        context: { unified: [] }
      }
    ]
    installBoundary(boundary)
    renderChat({ conversationId: 'conversation-b' })

    const heading = await screen.findByRole('heading', { name: 'Summary', level: 1 })
    const list = screen.getByRole('list')
    const strong = screen.getByText('First item')
    const quote = screen.getByText('Important note').closest('blockquote')
    expect(heading.className).toContain('text-base')
    expect(heading.className).toContain('font-bold')
    expect(heading.style.fontWeight).toBe('700')
    expect(list.className).toContain('list-disc')
    expect(list.style.listStyleType).toBe('disc')
    expect(strong.tagName).toBe('STRONG')
    expect(strong.className).toContain('font-bold')
    expect(strong.style.fontWeight).toBe('700')
    expect(quote?.className).toContain('border-l-2')
  })

  it('includes citation searches in the same work timeline', async () => {
    const boundary = new ChatBoundary()
    boundary.messages['conversation-b'] = [
      {
        id: 1,
        role: 'assistant',
        content: 'Answer.',
        context: {
          unified: [],
          toolCalls: [
            { name: 'search_memory', result: 'memory hits' },
            { name: 'search_replay', result: 'Replay hits' }
          ]
        }
      }
    ]
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-b' })

    await screen.findByText('Answer.')
    const work = await screen.findByRole('button', { name: /Work done/ })
    await user.click(work)
    expect(screen.getByRole('button', { name: 'Searched memory, complete' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Searched activity, complete' })).toBeTruthy()
  })

  it('keeps one live inline tool row and clears the old running label when it completes', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    await send('Look up the release status', user)
    await waitFor(() => expect(boundary.calls).toHaveLength(1))

    boundary.emitToolStep(0, 'web_search')
    expect(await screen.findByRole('button', { name: 'Searched the web, running' })).toBeTruthy()
    expect(screen.getByText('Running web_search…')).toBeTruthy()

    boundary.emitToolResult(0, 'web_search', LONG_RESULT)
    const completed = await screen.findByRole('button', { name: 'Searched the web, complete' })
    await waitFor(() => expect(screen.queryByText('Running web_search…')).toBeNull())
    expect(screen.getAllByRole('button', { name: 'Searched the web, complete' })).toHaveLength(1)

    await user.click(completed)
    expect(await screen.findByText(LONG_RESULT)).toBeTruthy()

    boundary.emit(0, 'Here is the release status.')
    boundary.resolve(0, 'Here is the release status.')
  })

  it('keeps a final Web Use intake result as Action needed, not Work done', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    await send('Continue the flight search', user)
    await waitFor(() => expect(boundary.calls).toHaveLength(1))

    const result = 'Web Use was not started. Please confirm the departure airport.'
    boundary.emitToolStep(0, 'web_use')
    boundary.emitToolResult(0, 'web_use', result, 'pending')
    boundary.resolve(0, result, {
      toolCalls: [{ name: 'web_use', result, status: 'pending' }],
      unified: []
    })

    expect(await screen.findByRole('button', { name: /Action needed/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Work done/ })).toBeNull()
    expect(await screen.findByText(result)).toBeTruthy()
  })
})
