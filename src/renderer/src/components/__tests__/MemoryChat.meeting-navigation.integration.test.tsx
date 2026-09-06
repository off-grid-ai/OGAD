// @vitest-environment jsdom

// A meeting found by Chat is not another chat session. This drives the real source disclosure and
// proves that its meeting card crosses the renderer navigation boundary with the exact meeting ID.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryChat } from '../MemoryChat'
import { TooltipProvider } from '../ui/tooltip'
import { ChatBoundary, installBoundary } from './harness/chat-boundary'

describe('<MemoryChat/> meeting source navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('opens the exact meeting cited in a chat answer', async () => {
    const boundary = new ChatBoundary()
    boundary.messages['conversation-a'] = [
      {
        id: 1,
        role: 'assistant',
        content: 'The launch decision was made during the weekly review. [S1]',
        context: {
          unified: [
            {
              kind: 'meeting',
              refId: 42,
              title: 'Weekly launch review',
              snippet: 'The team approved the revised launch plan.',
              surface: 'Meetings',
              ts: Date.UTC(2026, 7, 24, 16, 0, 0),
              imagePath: null
            }
          ]
        }
      }
    ]
    installBoundary(boundary)
    const onNavigateToMeeting = vi.fn()
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <MemoryChat
          openTarget={{ conversationId: 'conversation-a' }}
          onNavigateToMeeting={onNavigateToMeeting}
        />
      </TooltipProvider>
    )

    await user.click(await screen.findByRole('button', { name: /searched your memory/i }))
    await user.click(screen.getByRole('button', { name: /weekly launch review/i }))

    expect(onNavigateToMeeting).toHaveBeenCalledOnce()
    expect(onNavigateToMeeting).toHaveBeenCalledWith(42)
  })
})
