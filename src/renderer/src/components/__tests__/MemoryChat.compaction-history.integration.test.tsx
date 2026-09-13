// @vitest-environment jsdom

import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { ChatBoundary, installBoundary, renderChat, send } from './harness/chat-boundary'

afterEach(cleanup)

it('keeps the active turn and a short earlier excerpt after a saved compaction notice', async () => {
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  const boundary = new ChatBoundary()
  const olderAnswer = `Earlier answer ${'old detail '.repeat(450)}END-OF-OLD-ANSWER`
  await boundary.addRagMessage('conversation-a', 'user', 'Explain the project')
  await boundary.addRagMessage('conversation-a', 'assistant', olderAnswer)
  await boundary.addRagMessage('conversation-a', 'user', 'hi')
  await boundary.addRagMessage('conversation-a', 'assistant', '_Compacted_', { notice: true })
  await boundary.addRagMessage('conversation-a', 'assistant', 'Hello!')
  Object.assign(boundary.api, {
    getSettings: async () => ({ composerToolsOn: true }),
    getLlmSettings: async () => ({ ctxSize: 4096 }),
    toolChat: async (_query: string, history: Array<{ role: string; content: string }>) => ({
      answer:
        history.some((turn) => turn.content === 'hi') &&
        history.some((turn) => turn.content.startsWith('Earlier chat excerpts')) &&
        history.every((turn) => !turn.content.includes('END-OF-OLD-ANSWER'))
          ? 'The compacted history carried forward.'
          : 'The full old history returned.',
      toolCalls: [],
      unified: [],
      imageRequests: []
    })
  })
  installBoundary(boundary)

  const user = userEvent.setup()
  renderChat({ conversationId: 'conversation-a' })
  expect(
    await screen.findByText('Compacted conversation to make room for more messages.')
  ).toBeTruthy()
  await send('hi again', user)
  expect(await screen.findByText('The compacted history carried forward.')).toBeTruthy()
  expect(
    screen.getAllByText('Compacted conversation to make room for more messages.')
  ).toHaveLength(1)
})
