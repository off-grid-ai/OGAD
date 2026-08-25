// @vitest-environment jsdom

// A screen moment found by Chat crosses the real source-card interaction and seeks Replay.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryChat } from '../MemoryChat'
import { TooltipProvider } from '../ui/tooltip'
import { ChatBoundary, installBoundary } from './harness/chat-boundary'

describe('<MemoryChat/> Replay source navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('opens the exact captured moment cited in a chat answer', async () => {
    const capturedAt = Date.UTC(2026, 7, 24, 16, 30, 0)
    const boundary = new ChatBoundary()
    boundary.messages['conversation-a'] = [
      {
        id: 1,
        role: 'assistant',
        content: 'You reviewed the AURORA launch checklist in Linear. [S1]',
        context: {
          unified: [
            {
              key: 'obs:42',
              kind: 'screen',
              refId: 42,
              title: 'Linear',
              snippet: 'Reviewed the AURORA launch checklist in Linear.',
              surface: 'Linear',
              ts: capturedAt,
              imagePath: '/captures/capture-aurora.png',
              score: 1
            }
          ]
        }
      }
    ]
    installBoundary(boundary)
    const onSeekReplay = vi.fn()
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <MemoryChat openTarget={{ conversationId: 'conversation-a' }} onSeekReplay={onSeekReplay} />
      </TooltipProvider>
    )

    await user.click(await screen.findByRole('button', { name: /searched your memory/i }))
    await user.click(screen.getByRole('button', { name: /open in Replay/i }))

    expect(onSeekReplay).toHaveBeenCalledOnce()
    expect(onSeekReplay).toHaveBeenCalledWith(capturedAt)
  })
})
