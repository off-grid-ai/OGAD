// @vitest-environment jsdom

// A reply shows its time the moment it finishes, without leaving the chat. The live reply used to be
// built without a createdAt, so its time appeared only after navigating away and back (a reload from
// storage). Real MemoryChat over the chat boundary harness (only window.api is faked).
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTaskSessionStoreForTests } from '../../lib/task-session-store'
import { clearRegisteredSlots } from '../../bootstrap/slotRegistry'
import { ChatBoundary, installBoundary, renderChat, send } from './harness/chat-boundary'

const CLOCK = /\b\d{1,2}:\d{2}\b/

describe('<MemoryChat/> reply time', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      callback(0)
      return 1
    }
    resetTaskSessionStoreForTests()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    clearRegisteredSlots()
  })

  it('shows the time on a reply as soon as it finishes, without leaving the chat', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    await send('What is on my calendar?', user)
    await waitFor(() => expect(boundary.calls).toHaveLength(1))
    boundary.emit(0, 'Nothing until three.')
    boundary.resolve(0, 'Nothing until three.')

    const reply = await waitFor(() => {
      const row = screen
        .getByText('Nothing until three.')
        .closest('[data-testid^="chat-message-"]') as HTMLElement | null
      expect(row).toBeTruthy()
      expect(within(row!).queryAllByRole('button', { name: 'Message actions' }).length).toBe(1)
      return row!
    })
    await waitFor(() => expect(reply.textContent).toMatch(CLOCK))
  })
})
