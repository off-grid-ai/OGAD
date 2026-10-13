// @vitest-environment jsdom
//
// What the chat tells the window the assistant is doing (an on-screen companion follows it): working
// while it answers, done when the answer arrives, then idle. Closing the chat in that short rest settles
// it at once, rather than from a timer that outlives the chat. The real MemoryChat runs behind the one
// stateful preload boundary (harness/chat-boundary); nothing of Off Grid AI's is mocked.

import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { onAssistantActivity, type AssistantActivity } from '../../lib/assistant-activity'
import { resetTaskSessionStoreForTests } from '../../lib/task-session-store'
import { clearRegisteredSlots } from '../../bootstrap/slotRegistry'
import { ChatBoundary, installBoundary, renderChat, send } from './harness/chat-boundary'

describe('<MemoryChat/> - the assistant activity it announces', () => {
  let heard: AssistantActivity[]
  let stopListening: () => void

  beforeEach(() => {
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
    resetTaskSessionStoreForTests()
    heard = []
    stopListening = onAssistantActivity((activity) => heard.push(activity))
  })

  afterEach(() => {
    stopListening()
    cleanup()
    clearRegisteredSlots()
  })

  it('settles the assistant when the chat closes while it rests after an answer', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    const user = userEvent.setup()
    const chat = renderChat({ conversationId: 'conversation-a' })

    await send('What is on today?', user)
    await waitFor(() => expect(heard).toContain('working'))
    boundary.resolve(0, 'Two meetings and a review.')
    await screen.findByText('Two meetings and a review.')
    await waitFor(() => expect(heard.at(-1)).toBe('done'))

    chat.unmount()
    expect(heard.at(-1)).toBe('idle')

    // Nothing is left to fire once the chat is gone.
    const settled = heard.length
    await new Promise((wait) => setTimeout(wait, 1_200))
    expect(heard).toHaveLength(settled)
  })

  it('rests after an answer, and goes idle on its own while the chat stays open', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    await send('What is on today?', user)
    await waitFor(() => expect(heard).toContain('working'))
    boundary.resolve(0, 'Two meetings and a review.')
    await screen.findByText('Two meetings and a review.')
    await waitFor(() => expect(heard.at(-1)).toBe('idle'), { timeout: 2_000 })
  })
})
