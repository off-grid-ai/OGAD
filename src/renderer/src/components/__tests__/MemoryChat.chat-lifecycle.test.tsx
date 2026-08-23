// @vitest-environment jsdom
//
// RELEASE_TEST_CHECKLIST #36-#42, #47-#48 - chat lifecycle integration coverage.
//
// These tests mount the real MemoryChat and drive its real composer, queue, stop,
// conversation switching, project selection, stream routing, and persistence paths.
// Electron IPC and the local model runtime cannot run in jsdom, so one stateful preload
// boundary stands in for them. No Off Grid component, hook, store, or orchestration code
// is mocked.

import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryChat } from '../MemoryChat'
import { TooltipProvider } from '../ui/tooltip'
import {
  ChatBoundary,
  installBoundary,
  renderChat,
  send,
  type ThinkSplitterFactory
} from './harness/chat-boundary'

describe('<MemoryChat/> - chat lifecycle integration (#36-#42, #47-#48)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      callback(0)
      return 1
    }
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders streamed reasoning separately from the final answer when Thinking is enabled (#36)', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    await user.click(await screen.findByRole('button', { name: 'Thinking' }))
    await send('Compare the two release plans', user)
    await waitFor(() => expect(boundary.calls).toHaveLength(1))
    expect(boundary.calls[0]!.thinking).toBe(true)

    boundary.emitReasoning(0, 'First compare risk, then reversibility.')
    boundary.emit(0, 'Choose plan B because it is reversible.')

    expect(await screen.findByText('Thinking…')).toBeTruthy()
    expect(screen.getByText('First compare risk, then reversibility.')).toBeTruthy()
    expect(screen.getByText('Choose plan B because it is reversible.')).toBeTruthy()

    boundary.resolve(0, 'Choose plan B because it is reversible.')

    const thoughtProcess = await screen.findByRole('button', { name: /thought process/i })
    const thoughtProcessLabel = screen.getByText('Thought process')
    expect(thoughtProcessLabel.classList.contains('whitespace-nowrap')).toBe(true)
    await user.click(thoughtProcess)
    expect(await screen.findByText('First compare risk, then reversibility.')).toBeTruthy()
    expect(screen.getByText('Choose plan B because it is reversible.')).toBeTruthy()
    expect(screen.queryByText(/<\/?think>/i)).toBeNull()
  })

  it('keeps actions off supporting context and below the real assistant reply', async () => {
    const boundary = new ChatBoundary()
    boundary.messages['conversation-a'] = [
      {
        id: 1,
        role: 'assistant',
        content:
          '<think>__LABEL:Enhanced prompt__\nA cinematic lighthouse in a winter storm.</think>'
      },
      {
        id: 2,
        role: 'assistant',
        content: 'Generated image for: a lighthouse in a winter storm'
      }
    ]
    installBoundary(boundary)

    renderChat({ conversationId: 'conversation-a' })

    const disclosure = await screen.findByRole('button', { name: /enhanced prompt/i })
    const answer = screen.getByText('Generated image for: a lighthouse in a winter storm')
    const speak = screen.getByRole('button', { name: 'Speak' })
    expect(screen.getByTestId('supporting-context-bubble')).toBeTruthy()
    expect(screen.getByTestId('chat-message-1').className).toContain('mb-2')
    expect(screen.getByTestId('chat-message-2').className).toContain('mb-5')
    expect(disclosure.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0
    )
    expect(answer.compareDocumentPosition(speak) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(screen.getAllByTitle('Copy')).toHaveLength(1)
    expect(screen.getAllByTitle('Regenerate')).toHaveLength(1)
  })

  it('strips inline think markers from a plain reply through the real stream parser (#37)', async () => {
    const parserPath = ['../../../../main/llm', 'sse-stream'].join('/')
    const parser = await vi.importActual<{ createThinkSplitter: ThinkSplitterFactory }>(parserPath)
    const boundary = new ChatBoundary(parser.createThinkSplitter)
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    await send('Give me the direct release status', user)
    await waitFor(() => expect(boundary.calls).toHaveLength(1))
    expect(boundary.calls[0]!.thinking).toBe(false)

    boundary.emitRaw(0, '<think>internal parser state')
    boundary.emitRaw(0, '</think>The release checks are green.')
    boundary.resolveRaw(0)

    expect(await screen.findByText('The release checks are green.')).toBeTruthy()
    expect(screen.queryByText(/<think>|<\/think>/i)).toBeNull()
    expect(screen.queryByText(/internal parser state<\/think>/i)).toBeNull()
    await waitFor(() =>
      expect(
        boundary.messages['conversation-a']!.some(
          (message) =>
            message.role === 'assistant' && message.content === 'The release checks are green.'
        )
      ).toBe(true)
    )
  })

  it('hides a delimiter-only assistant row synced from a mobile tool turn', async () => {
    const boundary = new ChatBoundary()
    boundary.messages['conversation-a'] = [
      { id: 1, role: 'user', content: 'Look this up' },
      { id: 2, role: 'assistant', content: '<think>  </think>' },
      { id: 3, role: 'assistant', content: 'Synthetic search result' },
      { id: 4, role: 'assistant', content: 'Here is the final answer.' }
    ]
    installBoundary(boundary)

    renderChat({ conversationId: 'conversation-a' })

    expect(await screen.findByText('Synthetic search result')).toBeTruthy()
    expect(screen.getByText('Here is the final answer.')).toBeTruthy()
    expect(screen.queryByText(/<think>|<\/think>/i)).toBeNull()
  })

  it('does not play a canceled synthesis and stops active speech on navigation (#106)', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    const audios: Array<{ play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> }> = []
    vi.stubGlobal(
      'Audio',
      class {
        error = null
        onended: (() => void) | null = null
        onerror: (() => void) | null = null
        play = vi.fn(async () => undefined)
        pause = vi.fn()

        constructor(_url: string) {
          audios.push(this)
        }
      }
    )
    const user = userEvent.setup()
    const view = renderChat({ conversationId: 'conversation-b' })

    await user.click(await screen.findByRole('button', { name: 'Speak' }))
    await waitFor(() => expect(boundary.speechTurns).toHaveLength(1))
    await user.click(screen.getByRole('button', { name: /Generating/ }))
    boundary.speechTurns[0]!.reject(new Error('canceled synthesis settled late'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Speak' })).toBeTruthy())
    expect(audios).toHaveLength(0)
    expect(screen.queryByRole('alert')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Speak' }))
    await waitFor(() => expect(boundary.speechTurns).toHaveLength(2))
    boundary.speechTurns[1]!.resolve({ dataUrl: 'data:audio/wav;base64,UklGRg==' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy())
    expect(audios).toHaveLength(1)
    expect(audios[0]!.play).toHaveBeenCalledOnce()

    view.unmount()
    expect(audios[0]!.pause).toHaveBeenCalledOnce()
  })

  it('shows an actionable error when assistant speech cannot be generated (#105)', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-b' })

    await user.click(await screen.findByRole('button', { name: 'Speak' }))
    await waitFor(() => expect(boundary.speechTurns).toHaveLength(1))
    boundary.speechTurns[0]!.reject(new Error('native worker unavailable'))

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /speech could not be generated.*text-to-speech is installed in settings/i
    )
    expect(screen.getByRole('button', { name: 'Speak' })).toBeTruthy()
  })

  it('sends markdown with a reference definition to speech without crashing', async () => {
    const boundary = new ChatBoundary()
    boundary.messages['conversation-b']![0]!.content =
      'Read this answer.\n\n[private-source]: https://secret.invalid/token'
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-b' })

    await user.click(await screen.findByRole('button', { name: 'Speak' }))

    await waitFor(() => expect(boundary.speechTurns).toHaveLength(1))
    expect(boundary.api.speak).toHaveBeenCalledWith('Read this answer.')
  })

  it('streams and persists the first local reply in one assistant bubble (#32)', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-b' })

    await send('Give me a local reply', user)
    await waitFor(() => expect(boundary.calls).toHaveLength(1))
    boundary.emit(0, 'One local response')
    expect(await screen.findByText('One local response')).toBeTruthy()

    boundary.resolve(0, 'One local response')

    await waitFor(() => {
      expect(screen.getAllByText('One local response')).toHaveLength(1)
      expect(
        boundary.messages['conversation-b']!.map(({ role, content }) => [role, content])
      ).toEqual([
        ['assistant', 'Conversation B baseline'],
        ['user', 'Give me a local reply'],
        ['assistant', 'One local response']
      ])
    })
  })

  it('keeps No memory visible and sends the turn without retrieval (#33)', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-b' })

    expect(await screen.findByRole('button', { name: /no memory/i })).toBeTruthy()

    await send('Use only this conversation', user)
    await waitFor(() => expect(boundary.calls).toHaveLength(1))
    expect(boundary.calls[0]).toMatchObject({
      query: 'Use only this conversation',
      noMemory: true,
      projectId: null,
      conversationId: 'conversation-b'
    })

    boundary.resolve(0, 'Conversation-only answer')
    expect(await screen.findByText('Conversation-only answer')).toBeTruthy()
    expect(screen.getByRole('button', { name: /no memory/i })).toBeTruthy()
  })

  it('stops before the first token and immediately permits the next turn (#38)', async () => {
    const boundary = new ChatBoundary()
    boundary.blockNextUserWrite()
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    await screen.findByPlaceholderText(/project alpha/i)
    await send('cancel before the model starts', user)
    await user.click(await screen.findByRole('button', { name: /stop generating/i }))
    boundary.releaseUserWrite()

    await waitFor(() => expect(boundary.api.ragChat).not.toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /stop generating/i })).toBeNull()
    )
    expect(screen.getByText('cancel before the model starts')).toBeTruthy()

    await send('the next turn still runs', user)
    await waitFor(() => expect(boundary.calls).toHaveLength(1))
    boundary.resolve(0, 'The next turn completed.')

    expect(await screen.findByText('The next turn completed.')).toBeTruthy()
    expect(boundary.calls[0]!.query).toBe('the next turn still runs')
  })

  it('stops a live stream, retains its partial answer, and clears busy state (#39)', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    await send('stream a long response', user)
    await waitFor(() => expect(boundary.calls).toHaveLength(1))
    boundary.emit(0, 'Partial answer')
    expect(await screen.findByText('Partial answer')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /stop generating/i }))
    expect(boundary.cancelRag).toHaveBeenCalledWith(boundary.calls[0]!.streamId)
    boundary.resolve(0, 'Partial answer')

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /stop generating/i })).toBeNull()
      expect(
        boundary.addRagMessage.mock.calls.some(
          (call) => call[1] === 'assistant' && call[2] === 'Partial answer'
        )
      ).toBe(true)
    })
    expect(screen.queryByText('No response returned.')).toBeNull()
  })

  it('drains queued messages in send order without duplication or loss (#40)', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    await send('first question', user)
    await waitFor(() => expect(boundary.calls).toHaveLength(1))
    await send('second question', user)
    expect(await screen.findByText('1 queued')).toBeTruthy()

    boundary.resolve(0, 'First answer')
    await waitFor(() => expect(boundary.calls).toHaveLength(2))
    boundary.resolve(1, 'Second answer')

    expect(await screen.findByText('First answer')).toBeTruthy()
    expect(await screen.findByText('Second answer')).toBeTruthy()
    expect(boundary.calls.map((call) => call.query)).toEqual(['first question', 'second question'])
    await waitFor(() => {
      const persisted = boundary.messages['conversation-a']!.map((message) => [
        message.role,
        message.content
      ])
      expect(persisted).toEqual([
        ['user', 'first question'],
        ['assistant', 'First answer'],
        ['user', 'second question'],
        ['assistant', 'Second answer']
      ])
    })
  })

  it('keeps conversation A stream state out of B and completes against A (#41)', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    const user = userEvent.setup()
    const view = renderChat({ conversationId: 'conversation-a' })

    await send('answer only in A', user)
    await waitFor(() => expect(boundary.calls).toHaveLength(1))
    boundary.emit(0, 'A partial')
    expect(await screen.findByText('A partial')).toBeTruthy()

    view.rerender(
      <TooltipProvider>
        <MemoryChat openTarget={{ conversationId: 'conversation-b' }} />
      </TooltipProvider>
    )
    expect(await screen.findByText('Conversation B baseline')).toBeTruthy()
    expect(screen.queryByText('A partial')).toBeNull()

    boundary.emit(0, ' must stay in A')
    boundary.resolve(0, 'A completed against A history')
    await waitFor(() =>
      expect(
        boundary.addRagMessage.mock.calls.some(
          (call) =>
            call[0] === 'conversation-a' &&
            call[1] === 'assistant' &&
            call[2] === 'A completed against A history'
        )
      ).toBe(true)
    )
    expect(screen.queryByText('A completed against A history')).toBeNull()

    view.rerender(
      <TooltipProvider>
        <MemoryChat openTarget={{ conversationId: 'conversation-a' }} />
      </TooltipProvider>
    )
    expect(await screen.findByText('A completed against A history')).toBeTruthy()
    expect(boundary.calls[0]!.conversationId).toBe('conversation-a')
  })

  it('keeps a result and its artifact attributed to the project captured at send time (#42)', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    await send('build the alpha status card', user)
    await waitFor(() => expect(boundary.calls).toHaveLength(1))

    // Switch this chat's memory scope to a different project AFTER sending, via the scope
    // selector (targeted by its title so it is not confused with the header's "In Project…"
    // link, which shares the project name). The header then reflects the new active project;
    // the already-sent turn must stay attributed to alpha (asserted below).
    const scopeButton = screen.getByTitle(/choose what this chat can draw on/i)
    scopeButton.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(scopeButton.getAttribute('data-state')).toBe('open'))
    await user.click(await screen.findByRole('menuitem', { name: /project beta/i }))
    expect(await screen.findByRole('button', { name: /in project beta/i })).toBeTruthy()

    boundary.resolve(0, 'Alpha result\n```html\n<div>Alpha artifact</div>\n```')

    await waitFor(() => expect(boundary.saveArtifact).toHaveBeenCalledTimes(1))
    expect(boundary.calls[0]!.projectId).toBe('project-alpha')
    expect(boundary.saveArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-a',
        projectId: 'project-alpha',
        kind: 'html',
        code: '<div>Alpha artifact</div>'
      })
    )
    expect(await screen.findByText('Alpha result')).toBeTruthy()
  })

  it('regenerates from the same user turn without duplicating it (#47)', async () => {
    const boundary = new ChatBoundary()
    boundary.messages['conversation-a'] = [
      { id: 20, role: 'user', content: 'Explain the release gate' },
      { id: 21, role: 'assistant', content: 'Original explanation', context: { unified: [] } }
    ]
    boundary.conversations[0]!.message_count = 2
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    await user.click(await screen.findByRole('button', { name: /^regenerate$/i }))
    await waitFor(() => expect(boundary.calls).toHaveLength(1))

    expect(boundary.calls[0]).toMatchObject({
      query: 'Explain the release gate',
      projectId: 'project-alpha',
      conversationId: 'conversation-a'
    })
    expect(boundary.truncateRagMessages).toHaveBeenCalledWith('conversation-a', 1)
    expect(screen.getAllByText('Explain the release gate')).toHaveLength(1)

    boundary.resolve(0, 'Updated explanation')

    expect(await screen.findByText('Updated explanation')).toBeTruthy()
    expect(screen.queryByText('Original explanation')).toBeNull()
    expect(screen.getAllByText('Explain the release gate')).toHaveLength(1)
    await waitFor(() =>
      expect(
        boundary.messages['conversation-a']!.map(({ role, content }) => [role, content])
      ).toEqual([
        ['user', 'Explain the release gate'],
        ['assistant', 'Updated explanation']
      ])
    )
  })

  it('shows a failed turn, clears busy state, and permits the next send (#48)', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    await send('first turn fails', user)
    await waitFor(() => expect(boundary.calls).toHaveLength(1))
    boundary.reject(0, new Error('local model unavailable'))

    expect(
      await screen.findByText('Sorry, something went wrong while generating a response.')
    ).toBeTruthy()
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /stop generating/i })).toBeNull()
    )

    await send('second turn succeeds', user)
    await waitFor(() => expect(boundary.calls).toHaveLength(2))
    boundary.resolve(1, 'Recovery answer')

    expect(await screen.findByText('Recovery answer')).toBeTruthy()
    expect(boundary.calls.map(({ query }) => query)).toEqual([
      'first turn fails',
      'second turn succeeds'
    ])
  })
})
