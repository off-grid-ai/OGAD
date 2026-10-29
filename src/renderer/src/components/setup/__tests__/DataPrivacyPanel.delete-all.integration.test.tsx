// @vitest-environment jsdom
// Delete all asks twice, and only a yes to both erases anything. Main is faked at the IPC line;
// the panel and the in-app dialog are real.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialogHost } from '../../ConfirmDialogHost'
import { DataPrivacyPanel } from '../DataPrivacyPanel'

describe('<DataPrivacyPanel/> delete all', () => {
  let api: {
    getDataSummary: ReturnType<typeof vi.fn>
    clearDataCategory: ReturnType<typeof vi.fn>
    deleteAllData: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    api = {
      getDataSummary: vi.fn(async () => [
        { id: 'chats', label: 'Chats', detail: 'Conversations and messages', count: 4, bytes: 0 }
      ]),
      clearDataCategory: vi.fn(async () => undefined),
      deleteAllData: vi.fn(async () => undefined)
    }
    ;(globalThis as unknown as { window: Window }).window.api = api as never
  })

  afterEach(() => {
    cleanup()
  })

  async function askToDeleteAll(): Promise<ReturnType<typeof userEvent.setup>> {
    const user = userEvent.setup()
    render(
      <>
        <DataPrivacyPanel />
        <ConfirmDialogHost />
      </>
    )
    await user.click(await screen.findByRole('button', { name: 'Delete all my data' }))
    return user
  }

  it('erases nothing when the first question is cancelled', async () => {
    const user = await askToDeleteAll()
    const first = await screen.findByRole('alertdialog', { name: 'Delete ALL your data?' })
    await user.click(within(first).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(api.deleteAllData).not.toHaveBeenCalled()
  })

  it('erases nothing when the second question is cancelled', async () => {
    const user = await askToDeleteAll()
    const first = await screen.findByRole('alertdialog', { name: 'Delete ALL your data?' })
    await user.click(within(first).getByRole('button', { name: 'Delete all' }))

    const second = await screen.findByRole('alertdialog', { name: 'Are you absolutely sure?' })
    await user.click(within(second).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(api.deleteAllData).not.toHaveBeenCalled()
  })
})
