// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatMarkdown } from '../ChatMarkdown'
import { resetTaskSessionStoreForTests } from '@renderer/lib/task-session-store'
import {
  closeTaskWorkspace,
  onOpenTaskSidePanel,
  type OpenTaskPanelRequest
} from '@renderer/lib/task-side-panel'
import { setActiveConversationId } from '@renderer/lib/active-conversation'

describe('ChatMarkdown links', () => {
  beforeEach(() => {
    resetTaskSessionStoreForTests()
    closeTaskWorkspace()
    setActiveConversationId(null)
  })

  afterEach(() => {
    cleanup()
    closeTaskWorkspace()
    resetTaskSessionStoreForTests()
    vi.restoreAllMocks()
  })

  it('opens a web link in the Off Grid AI browser bound to the active chat and refuses unsafe links', () => {
    const openExternal = vi.fn()
    const openUrl = vi.fn(async () => ({ sessionId: 'manual-1' }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { openExternal, browser: { openUrl } }
    })
    // The page opens into whichever chat the user is in, so the docked pane scopes it there.
    setActiveConversationId('conv-42')

    render(
      <ChatMarkdown content="[Docs](https://example.com/docs) [Unsafe](javascript:alert(1))" />
    )
    fireEvent.click(screen.getByRole('link', { name: 'Docs' }))
    fireEvent.click(screen.getByText('Unsafe'))

    expect(openUrl).toHaveBeenCalledTimes(1)
    expect(openUrl).toHaveBeenCalledWith('https://example.com/docs', 'conv-42')
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('keeps mail links with the operating system', () => {
    const openExternal = vi.fn()
    const openUrl = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { openExternal, browser: { openUrl } }
    })

    render(<ChatMarkdown content="[Email](mailto:hello@example.com)" />)
    fireEvent.click(screen.getByRole('link', { name: 'Email' }))

    expect(openExternal).toHaveBeenCalledWith('mailto:hello@example.com')
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('opens a known contextual task reference with the keyboard and leaves unknown references plain', async () => {
    const requests: OpenTaskPanelRequest[] = []
    const offOpen = onOpenTaskSidePanel((request) => requests.push(request))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        tasks: {
          list: vi.fn(async () => [
            {
              taskId: '123e4567-e89b-12d3-a456-426614174000',
              kind: 'web_use',
              title: 'Research suppliers',
              status: 'done',
              steps: [],
              startedAt: 1,
              updatedAt: 2
            }
          ]),
          onChanged: vi.fn(() => () => undefined)
        }
      }
    })

    render(
      <ChatMarkdown content="The task reference is: 123e4567-e89b-12d3-a456-426614174000. Unknown task reference: missing-task. Arbitrary 00000000-0000-0000-0000-000000000000." />
    )

    const known = await screen.findByRole('button', {
      name: 'Open task details for 123e4567-e89b-12d3-a456-426614174000'
    })
    known.focus()
    await userEvent.keyboard('{Enter}')
    expect(requests).toContainEqual({
      taskId: '123e4567-e89b-12d3-a456-426614174000',
      kind: 'web_use',
      detail: true
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: /missing-task/ })).toBeNull())
    expect(screen.getByText(/Arbitrary 00000000-0000-0000-0000-000000000000/)).toBeTruthy()
    offOpen()
  })
})
