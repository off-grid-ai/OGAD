// @vitest-environment jsdom

import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatBoundary, installBoundary, renderChat } from './harness/chat-boundary'

describe('<MemoryChat/> speakable message integration', () => {
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

  it('shows and synthesizes a clean voice transcript instead of raw Markdown', async () => {
    const boundary = new ChatBoundary()
    boundary.messages['conversation-a'] = [
      {
        id: 1,
        role: 'assistant',
        content: '**Release ready.**\n\n[private-source]: https://secret.invalid/token'
      }
    ]
    boundary.conversations.find(({ id }) => id === 'conversation-a')!.message_count = 1
    installBoundary(boundary)
    const user = userEvent.setup()

    renderChat({ conversationId: 'conversation-a' })

    expect(await screen.findByText('Release ready.')).toBeTruthy()
    expect(screen.queryByText(/\*\*|private-source|secret\.invalid/)).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Speak' }))
    await waitFor(() => expect(boundary.speechTurns).toHaveLength(1))
    expect(boundary.api.speak).toHaveBeenCalledWith('Release ready.')
  })
})
