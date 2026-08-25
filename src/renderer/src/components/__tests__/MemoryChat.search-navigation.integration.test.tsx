// @vitest-environment jsdom

// A past chat found through universal Search keeps its exact conversation target when the
// result crosses the chat-tool and renderer boundaries. This drives the real source disclosure
// and the shared search-navigation owner instead of testing a local kind switch.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryChat } from '../MemoryChat'
import { TooltipProvider } from '../ui/tooltip'
import { ChatBoundary, installBoundary } from './harness/chat-boundary'

describe('<MemoryChat/> Search source navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('opens the exact past conversation returned by the chat Search tool', async () => {
    const boundary = new ChatBoundary()
    boundary.messages['conversation-a'] = [
      {
        id: 1,
        role: 'assistant',
        content: 'The rollout is planned for Friday. [S1]',
        context: {
          unified: [
            {
              key: 'chat:conversation-release',
              kind: 'chat',
              refId: 0,
              title: 'Release decision',
              snippet: 'We chose the starling rollout for Friday.',
              surface: 'Chat',
              url: 'conversation-release',
              ts: Date.UTC(2026, 7, 24, 16, 0, 0),
              imagePath: null,
              score: 1
            }
          ]
        }
      }
    ]
    installBoundary(boundary)
    const onNavigateToChat = vi.fn()
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <MemoryChat
          openTarget={{ conversationId: 'conversation-a' }}
          onNavigateToChat={onNavigateToChat}
        />
      </TooltipProvider>
    )

    await user.click(await screen.findByRole('button', { name: /searched your memory/i }))
    await user.click(screen.getByRole('button', { name: /release decision/i }))

    expect(onNavigateToChat).toHaveBeenCalledOnce()
    expect(onNavigateToChat).toHaveBeenCalledWith('conversation-release')
  })
})
