// @vitest-environment jsdom

import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatBoundary, installBoundary, renderChat } from './harness/chat-boundary'

describe('<MemoryChat/> sent-message Markdown', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders Markdown and turns bare domains into secure links', async () => {
    const boundary = new ChatBoundary()
    boundary.messages['conversation-a'] = [
      {
        id: 1,
        role: 'user',
        content:
          '**Research:** github.com/off-grid-ai and getoffgridai.co. Keep `example.com` as code and hello@example.com as text.'
      }
    ]
    installBoundary(boundary)
    renderChat({ conversationId: 'conversation-a' })

    const message = await screen.findByTestId('chat-message-1')
    expect(within(message).getByText('Research:').tagName).toBe('STRONG')
    expect(
      within(message).getByRole('link', { name: 'github.com/off-grid-ai' }).getAttribute('href')
    ).toBe('https://github.com/off-grid-ai')
    expect(
      within(message).getByRole('link', { name: 'getoffgridai.co' }).getAttribute('href')
    ).toBe('https://getoffgridai.co/')
    expect(within(message).getByText('example.com').tagName).toBe('CODE')
    expect(within(message).queryByRole('link', { name: 'example.com' })).toBeNull()
    expect(
      within(message).getByRole('link', { name: 'hello@example.com' }).getAttribute('href')
    ).toBe('mailto:hello@example.com')
  })
})
