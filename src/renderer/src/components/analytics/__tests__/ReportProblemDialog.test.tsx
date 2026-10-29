// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReportProblemDialog } from '../ReportProblemDialog'

/**
 * Copying the diagnostic log from Report a problem. Copy is an icon button, so the person finds it
 * by its name ("Copy log") and the name tells them what happened ("Copied" / "Copy failed"). Only
 * the preload bridge is faked: it is the process boundary.
 */

const api = {
  analytics: {
    readLog: vi.fn(),
    revealLog: vi.fn(),
    emailLog: vi.fn()
  },
  writeClipboardText: vi.fn()
}

describe('Report a problem: copy the log', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as unknown as { window: { api: unknown } }).window.api = api
    api.analytics.readLog.mockResolvedValue({
      path: '/logs/main.log',
      text: 'boot ok',
      truncated: false
    })
  })

  afterEach(() => cleanup())

  it('copies the log text and says it was copied', async () => {
    const user = userEvent.setup()
    api.writeClipboardText.mockResolvedValue(true)
    render(<ReportProblemDialog open onOpenChange={() => {}} />)

    const button = await screen.findByRole('button', { name: 'Copy log' })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    await user.click(button)

    expect(api.writeClipboardText).toHaveBeenCalledWith('boot ok')
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Copied')
  })

  it('says the copy failed when no clipboard takes the text', async () => {
    const user = userEvent.setup()
    api.writeClipboardText.mockResolvedValue(false)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }
    })
    render(<ReportProblemDialog open onOpenChange={() => {}} />)

    const button = await screen.findByRole('button', { name: 'Copy log' })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    await user.click(button)

    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeTruthy()
  })

  it('cannot copy an empty log', async () => {
    api.analytics.readLog.mockResolvedValue({ path: '', text: '', truncated: false })
    render(<ReportProblemDialog open onOpenChange={() => {}} />)

    await screen.findByText('The log is empty.')
    const button = screen.getByRole('button', { name: 'Copy log' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })
})
