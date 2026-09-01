// @vitest-environment jsdom

import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRegisteredSlots } from '../../bootstrap/slotRegistry'
import { resetTaskSessionStoreForTests } from '../../lib/task-session-store'
import { ChatBoundary, installBoundary, renderChat, send } from './harness/chat-boundary'

describe('sendMessage locks the project for the turn (D21)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetTaskSessionStoreForTests()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      callback(0)
      return 1
    }
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    clearRegisteredSlots()
  })

  it('keeps the streamed result and artifact in the project active when Send started', async () => {
    const boundary = new ChatBoundary()
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    await send('build the alpha status card', user)
    await waitFor(() => expect(boundary.calls).toHaveLength(1))

    const scopeButton = screen.getByTitle(/choose what this chat can draw on/i)
    scopeButton.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(scopeButton.getAttribute('data-state')).toBe('open'))
    await user.click(await screen.findByRole('menuitem', { name: /project beta/i }))
    expect(await screen.findByRole('button', { name: /in project beta/i })).toBeTruthy()

    boundary.resolve(0, 'Alpha result\n```html\n<div>Alpha artifact</div>\n```')

    await waitFor(() => expect(boundary.saveArtifact).toHaveBeenCalledTimes(1))
    expect(boundary.calls[0]!.projectId).toBe('project-alpha')
    expect(boundary.saveArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-a',
        projectId: 'project-alpha',
        kind: 'html',
        code: '<div>Alpha artifact</div>'
      })
    )
    expect(await screen.findByText('Alpha result')).toBeTruthy()
  })
})
