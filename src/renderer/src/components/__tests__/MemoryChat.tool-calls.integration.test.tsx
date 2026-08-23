// @vitest-environment jsdom

// Integration: tool calls persist on an assistant message and are readable. A message
// loaded with context.toolCalls renders each call as an inline disclosure; expanding it keeps
// the full result in the conversation instead of opening a separate viewer.
// Real MemoryChat through the chat-boundary harness; only the window.api seam is faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatBoundary, installBoundary, renderChat, send } from './harness/chat-boundary'

const LONG_RESULT =
  'GitHub — off-grid-ai/OGAD: Off Grid AI Desktop, a local-first on-device AI runtime.'

describe('<MemoryChat/> tool calls — persistent + inline', () => {
  beforeEach(() => {
    ;(Element.prototype as unknown as { scrollIntoView(): void }).scrollIntoView = () => {}
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      cb(0)
      return 1
    }
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
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

    const chip = await screen.findByRole('button', { name: /web_search/ })
    const markdownTool = await screen.findByRole('button', { name: /read_url/ })
    const answer = await screen.findByText('Here is what I found.')
    expect(answer.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(screen.queryByText(LONG_RESULT)).toBeNull()

    // The full result expands under the tool row. No modal or side viewer takes over the chat.
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

    const tool = await screen.findByRole('button', { name: /web_search/ })
    expect(tool.textContent).toContain('Completed in 1031 ms')
    expect(screen.queryByText(LONG_RESULT)).toBeNull()
    // A call followed by another call is one step of a turn; the last one closes the run. The gap
    // still says which is which - it is just no longer the between-MESSAGES gap, which spaced a
    // single turn's steps as far apart as separate conversations.
    expect(screen.getByTestId('chat-tool-message-1').className).toContain('mb-1')
    expect(screen.getByTestId('chat-tool-message-2').className).toContain('mb-2')

    await user.click(tool)
    expect(await screen.findByText(LONG_RESULT)).toBeTruthy()
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

  it('does not render a chip for search_memory (shown as source cards instead)', async () => {
    const boundary = new ChatBoundary()
    boundary.messages['conversation-b'] = [
      {
        id: 1,
        role: 'assistant',
        content: 'Answer.',
        context: { unified: [], toolCalls: [{ name: 'search_memory', result: 'memory hits' }] }
      }
    ]
    installBoundary(boundary)
    renderChat({ conversationId: 'conversation-b' })

    await screen.findByText('Answer.')
    expect(screen.queryByRole('button', { name: 'search_memory' })).toBeNull()
  })

  it('keeps one live inline tool row and clears the old running label when it completes', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    await send('Look up the release status', user)
    await waitFor(() => expect(boundary.calls).toHaveLength(1))

    boundary.emitToolStep(0, 'web_search')
    expect(await screen.findByRole('button', { name: 'Using web_search...' })).toBeTruthy()
    expect(screen.getByText('Running web_search…')).toBeTruthy()

    boundary.emitToolResult(0, 'web_search', LONG_RESULT)
    const completed = await screen.findByRole('button', { name: /web_search/ })
    await waitFor(() => expect(screen.queryByText('Running web_search…')).toBeNull())
    expect(screen.getAllByRole('button', { name: /web_search/ })).toHaveLength(1)

    await user.click(completed)
    expect(await screen.findByText(LONG_RESULT)).toBeTruthy()

    boundary.emit(0, 'Here is the release status.')
    boundary.resolve(0, 'Here is the release status.')
  })
})
