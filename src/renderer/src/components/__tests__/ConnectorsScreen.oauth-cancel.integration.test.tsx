// @vitest-environment jsdom

import React, { useEffect } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/bootstrap/slotRegistry', () => {
  function ReadyGoogleClient({
    onReadyChange
  }: Readonly<{ onReadyChange: (ready: boolean) => void }>): React.ReactElement {
    useEffect(() => onReadyChange(true), [onReadyChange])
    return <div>Your Google client</div>
  }

  return {
    SLOTS: { connectorSetup: 'connectors.setup' },
    getSlot: () => ReadyGoogleClient
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Google browser authorization cancellation', () => {
  it('lets the user cancel a pending OAuth attempt and restores the Connect action', async () => {
    let finishTest: ((result: { ok: false; error: string }) => void) | undefined
    const mcpRemove = vi.fn(async () => {
      finishTest?.({ ok: false, error: 'Authorization cancelled' })
    })

    ;(window as unknown as { api: unknown }).api = {
      mcpList: vi.fn(async () => []),
      mcpAdd: vi.fn(async () => 42),
      mcpTest: vi.fn(
        () =>
          new Promise<{ ok: false; error: string }>((resolve) => {
            finishTest = resolve
          })
      ),
      mcpRemove
    }

    const { ConnectorsScreen } = await import('../ConnectorsScreen')
    const user = userEvent.setup()
    render(<ConnectorsScreen />)

    const calendarCard = (await screen.findByText('Google Calendar')).closest('div.flex.flex-col')
    expect(calendarCard).toBeTruthy()
    await user.click(
      within(calendarCard as HTMLElement).getByRole('button', { name: /Connect with OAuth/i })
    )

    const authorizing = await within(calendarCard as HTMLElement).findByRole('button', {
      name: /Authorize in browser/i
    })
    expect(authorizing).toHaveProperty('disabled', true)

    const cancel = await within(calendarCard as HTMLElement).findByRole('button', {
      name: /Cancel authorization/i
    })
    await user.click(cancel)

    await waitFor(() => expect(mcpRemove).toHaveBeenCalledWith(42))
    expect(
      await within(calendarCard as HTMLElement).findByRole('button', {
        name: /Connect with OAuth/i
      })
    ).toBeTruthy()
    expect(within(calendarCard as HTMLElement).queryByText(/Authorization cancelled/i)).toBeNull()
  })
})
