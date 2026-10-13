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
    getSettings: async () => ({ composerConnectorsOn: true }),
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

it('sends the saved summary in place of the compacted turns after reopening the chat', async () => {
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  const boundary = new ChatBoundary()
  const olderAnswer = `Earlier answer ${'old detail '.repeat(450)}END-OF-OLD-ANSWER`
  await boundary.addRagMessage('conversation-b', 'user', 'Plan a trip to Lisbon')
  await boundary.addRagMessage('conversation-b', 'assistant', olderAnswer)
  await boundary.addRagMessage('conversation-b', 'user', 'Make it three days')
  await boundary.addRagMessage('conversation-b', 'assistant', '_Compacted_', {
    notice: true,
    compactionSummary: '## Goal\nA three-day Lisbon trip in May.'
  })
  await boundary.addRagMessage('conversation-b', 'assistant', 'Here is the three-day plan.')
  Object.assign(boundary.api, {
    getSettings: async () => ({ composerConnectorsOn: true }),
    getLlmSettings: async () => ({ ctxSize: 4096 }),
    toolChat: async (_query: string, history: Array<{ role: string; content: string }>) => ({
      answer:
        history[0]?.content.includes('## Goal\nA three-day Lisbon trip in May.') &&
        history.some((turn) => turn.content === 'Make it three days') &&
        history.every(
          (turn) =>
            !turn.content.includes('END-OF-OLD-ANSWER') &&
            !turn.content.startsWith('Earlier chat excerpts')
        )
          ? 'The summary carried forward.'
          : 'The summary was lost.',
      toolCalls: [],
      unified: [],
      imageRequests: []
    })
  })
  installBoundary(boundary)

  const user = userEvent.setup()
  renderChat({ conversationId: 'conversation-b' })
  expect(
    await screen.findByText('Compacted conversation to make room for more messages.')
  ).toBeTruthy()
  await send('Add a day trip', user)
  expect(await screen.findByText('The summary carried forward.')).toBeTruthy()
})
