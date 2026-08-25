// @vitest-environment jsdom
// The archive-before-delete UI contract: "Back up first" appears only for archivable
// categories, and when it is on the delete buttons route to archiveDataCategory (the
// fail-closed IPC) instead of the plain delete.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DataPrivacyPanel } from '../DataPrivacyPanel'
import { ARCHIVABLE_CATEGORIES } from '../../../../../shared/backup-contracts'

const SUMMARY = [
  { id: 'chats', label: 'Chats', detail: 'Conversations and messages', count: 3 },
  {
    id: 'captures',
    label: 'Screen captures',
    detail: 'Captured frames and OCR',
    count: 10,
    bytes: 5e6
  },
  { id: 'meetings', label: 'Meetings', detail: 'Recordings and transcripts', count: 2, bytes: 1e6 },
  { id: 'images', label: 'Generated images & artifacts', detail: 'Images', count: 1, bytes: 1e6 }
]

const api = {
  getDataSummary: vi.fn(async () => SUMMARY),
  clearDataCategory: vi.fn(async () => ({ success: true })),
  archiveDataCategory: vi.fn(async () => ({ status: 'cleared', archivedFiles: 10 })),
  deleteAllData: vi.fn(async () => ({ success: true }))
}

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = api
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(window, 'alert').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  api.clearDataCategory.mockClear()
  api.archiveDataCategory.mockClear()
})

const backupToggle = (label: string): HTMLElement =>
  screen.getByRole('button', { name: `Back up ${label} before deleting` })

describe('<DataPrivacyPanel/> archive-before-delete', () => {
  it('offers Back up first for exactly the archivable categories', async () => {
    render(<DataPrivacyPanel />)
    await waitFor(() => expect(screen.getByText('Screen captures')).toBeTruthy())
    expect(screen.getAllByRole('button', { name: /back up .* before deleting/i })).toHaveLength(
      ARCHIVABLE_CATEGORIES.length
    )
    expect(screen.queryByRole('button', { name: /back up chats/i })).toBeNull()
  })

  it('with Back up first ON, a retention chip archives instead of plain-deleting', async () => {
    const user = userEvent.setup()
    render(<DataPrivacyPanel />)
    await waitFor(() => expect(screen.getByText('Screen captures')).toBeTruthy())

    await user.click(backupToggle('Screen captures'))
    await user.click(screen.getAllByRole('button', { name: '> 30 days' })[0]!)

    expect(api.archiveDataCategory).toHaveBeenCalledWith('captures', 30)
    expect(api.clearDataCategory).not.toHaveBeenCalled()
  })

  it('with Back up first OFF, the chip plain-deletes as before', async () => {
    const user = userEvent.setup()
    render(<DataPrivacyPanel />)
    await waitFor(() => expect(screen.getByText('Screen captures')).toBeTruthy())

    await user.click(screen.getAllByRole('button', { name: '> 30 days' })[0]!)

    expect(api.clearDataCategory).toHaveBeenCalledWith('captures', 30)
    expect(api.archiveDataCategory).not.toHaveBeenCalled()
  })

  it('a failed archive tells the user nothing was deleted', async () => {
    api.archiveDataCategory.mockResolvedValueOnce({
      status: 'failed',
      error: 'disk full'
    } as never)
    const user = userEvent.setup()
    render(<DataPrivacyPanel />)
    await waitFor(() => expect(screen.getByText('Screen captures')).toBeTruthy())

    await user.click(backupToggle('Screen captures'))
    await user.click(screen.getAllByRole('button', { name: '> 3 days' })[0]!)

    await waitFor(() =>
      expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('nothing was deleted'))
    )
  })

  it('a declined confirm never reaches the archive IPC', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const user = userEvent.setup()
    render(<DataPrivacyPanel />)
    await waitFor(() => expect(screen.getByText('Screen captures')).toBeTruthy())

    await user.click(backupToggle('Screen captures'))
    await user.click(screen.getAllByRole('button', { name: '> 30 days' })[0]!)

    expect(api.archiveDataCategory).not.toHaveBeenCalled()
    expect(api.clearDataCategory).not.toHaveBeenCalled()
  })
})
