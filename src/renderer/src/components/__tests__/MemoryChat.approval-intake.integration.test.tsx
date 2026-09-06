// @vitest-environment jsdom

import { act, cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatBoundary, installBoundary, renderChat } from './harness/chat-boundary'

describe('<MemoryChat/> approval intake failure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
  })

  afterEach(() => cleanup())

  it('shows the Pro-store read failure and retries without creating a replacement approval', async () => {
    const boundary = new ChatBoundary()
    const approval = {
      id: 43,
      title: 'Create the external task',
      detail: 'Project Atlas',
      connector: 'Linear',
      tool: 'create_issue',
      args: '{"title":"Ship Atlas"}'
    }
    const proInvoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('approval database is locked'))
      .mockResolvedValueOnce([approval])
    Object.assign(boundary.api, { proInvoke })
    installBoundary(boundary)
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    act(() => {
      window.dispatchEvent(new CustomEvent('og:approval-intake', { detail: { approvalId: 43 } }))
    })

    expect(
      await screen.findByRole('heading', { name: 'Approval could not be opened' })
    ).toBeTruthy()
    expect(screen.getByText(/approval database is locked/i)).toBeTruthy()
    expect(screen.getByText(/approval is unchanged/i)).toBeTruthy()
    expect(proInvoke).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByTestId('approval-intake-43')).toBeTruthy()
    expect((screen.getByLabelText(/What should Off Grid AI do/) as HTMLTextAreaElement).value).toBe(
      'Create the external task'
    )
    expect(proInvoke).toHaveBeenCalledTimes(2)
    expect(proInvoke).toHaveBeenNthCalledWith(1, 'approvals:list')
    expect(proInvoke).toHaveBeenNthCalledWith(2, 'approvals:list')
  })
})
