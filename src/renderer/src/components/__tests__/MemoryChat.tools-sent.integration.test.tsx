// @vitest-environment jsdom

import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { ChatBoundary, installBoundary, renderChat, send } from './harness/chat-boundary'

afterEach(cleanup)

it('shows the tools offered to a model even when it calls none, and keeps them after reload', async () => {
  ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  const boundary = new ChatBoundary()
  Object.assign(boundary.api, {
    getSettings: async () => ({ composerToolsOn: true }),
    getLlmSettings: async () => ({ ctxSize: 4096 }),
    listTools: async () => [],
    mcpList: async () => [],
    toolChat: async () => ({
      answer: 'I can help with that.',
      toolCalls: [],
      unified: [],
      imageRequests: [],
      toolsOffered: ['web_use', 'calculator']
    })
  })
  installBoundary(boundary)

  const user = userEvent.setup()
  const chat = renderChat({ conversationId: 'conversation-b' })
  expect(screen.queryByRole('button', { name: 'Tools sent in request (2)' })).toBeNull()
  await send('Which tools are available?', user)

  expect(await screen.findByText('I can help with that.')).toBeTruthy()
  await user.click(await screen.findByRole('button', { name: 'Tools sent in request (2)' }))
  expect(screen.getByText('web_use')).toBeTruthy()
  expect(screen.getByText('calculator')).toBeTruthy()

  chat.unmount()
  renderChat({ conversationId: 'conversation-b' })
  expect(await screen.findByRole('button', { name: 'Tools sent in request (2)' })).toBeTruthy()
  expect(screen.queryByText('web_use')).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Tools sent in request (2)' }))
  expect(screen.getByText('web_use')).toBeTruthy()
})
