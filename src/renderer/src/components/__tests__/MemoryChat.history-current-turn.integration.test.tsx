// @vitest-environment jsdom

import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { ChatBoundary, installBoundary, renderChat, send } from './harness/chat-boundary'

afterEach(cleanup)

// The new question rides as the request's own user turn. Sending it in the history as well
// gives the model the same question twice.
it('sends the new question once, not again inside the history', async () => {
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  const boundary = new ChatBoundary()
  await boundary.addRagMessage('conversation-b', 'user', 'Plan a trip to Lisbon')
  await boundary.addRagMessage('conversation-b', 'assistant', 'Here is a plan.')
  Object.assign(boundary.api, {
    toolChat: async (query: string, history: Array<{ role: string; content: string }>) => ({
      answer: history.some((turn) => turn.role === 'user' && turn.content === query)
        ? 'The question arrived twice.'
        : 'The question arrived once.',
      toolCalls: [],
      unified: [],
      imageRequests: []
    })
  })
  installBoundary(boundary)

  const user = userEvent.setup()
  renderChat({ conversationId: 'conversation-b' })
  expect((await screen.findAllByText('Plan a trip to Lisbon')).length).toBeGreaterThan(0)
  await send('Make it three days', user)
  expect(await screen.findByText('The question arrived once.')).toBeTruthy()
})
