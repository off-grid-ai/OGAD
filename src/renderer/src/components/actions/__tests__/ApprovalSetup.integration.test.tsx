// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalSetup, type ApprovalSetupRecord } from '../ApprovalSetup'

const approval: ApprovalSetupRecord = {
  id: 4,
  title: 'Draft an email reply',
  detail: 'Reply to the latest thread.',
  connector: 'Gmail',
  tool: 'create_draft',
  args: JSON.stringify({ recipient: '<email>', body: 'Confirm the plan.' })
}

describe('<ApprovalSetup/>', () => {
  afterEach(() => cleanup())

  it('collects missing values before sending one normal Chat request', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<ApprovalSetup record={approval} onSubmit={onSubmit} onCancel={vi.fn()} />)

    const start = screen.getByRole('button', { name: 'Start in chat' })
    expect(start.hasAttribute('disabled')).toBe(true)
    await user.type(screen.getByLabelText(/recipient/i), 'alex@example.com')
    await user.click(start)

    expect(onSubmit).toHaveBeenCalledOnce()
    const submitted = onSubmit.mock.calls.at(0)?.[0] ?? ''
    expect(submitted).toContain('recipient: alex@example.com')
    expect(submitted).toContain('Use the normal task path.')
    expect(submitted).toContain('otherwise use Computer Use')
  })
})
