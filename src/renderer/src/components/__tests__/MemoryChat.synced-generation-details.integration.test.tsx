// @vitest-environment jsdom

import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mergeSyncedMessageContext, serializeSyncedMessageContext } from '@offgrid/sync'
import { afterEach, expect, it } from 'vitest'
import { ChatBoundary, installBoundary, renderChat } from './harness/chat-boundary'

afterEach(cleanup)

it('shows portable generation details from a synced reply after reload', async () => {
  const user = userEvent.setup()
  const context = mergeSyncedMessageContext(
    null,
    serializeSyncedMessageContext({
      durationMs: 3400,
      toolsOffered: ['web_use'],
      metrics: {
        estimatedPromptTokens: 1024,
        contextWindowTokens: 4096,
        decodeTokensPerSecond: 42.5,
        timeToFirstTokenSeconds: 0.37,
        completionTokens: 128,
        totalSeconds: 3.4
      }
    })
  )
  const boundary = new ChatBoundary()
  Object.assign(boundary.api, {
    getSettings: async () => ({ showGenerationDetails: true }),
    getLlmSettings: async () => ({}),
    getRagMessages: async () => [
      {
        id: 'synced-mobile-reply',
        role: 'assistant',
        content: 'Answer from phone',
        context,
        created_at: '2026-09-12T18:00:00.000Z'
      }
    ]
  })
  installBoundary(boundary)

  const chat = renderChat({ conversationId: 'conversation-a' })
  expect(await screen.findByText('Answer from phone')).toBeTruthy()
  expect(screen.queryByTestId('generation-metrics')).toBeNull()
  await user.click(await screen.findByRole('button', { name: 'Generation details' }))
  let details = await screen.findByTestId('generation-metrics')
  expect(details.textContent).toContain('Context: ~25% used')
  expect(details.textContent).toContain('42.5 tok/s')
  expect(details.textContent).toContain('TTFT 0.37s')
  expect(details.textContent).toContain('128 tokens')
  expect(details.textContent).toContain('3.4s total')
  expect(await screen.findByRole('button', { name: 'Tools sent in request (1)' })).toBeTruthy()

  chat.unmount()
  renderChat({ conversationId: 'conversation-a' })
  expect(screen.queryByTestId('generation-metrics')).toBeNull()
  await user.click(await screen.findByRole('button', { name: 'Generation details' }))
  details = await screen.findByTestId('generation-metrics')
  expect(details.textContent).toContain('Context: ~25% used')
  expect(details.textContent).toContain('42.5 tok/s')
})
