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
  deleteAllData: vi.fn(async () => ({ success: true })),
  getAutoCleanupStatus: vi.fn(async () => ({
    config: { retentionDays: 0, archiveDir: null },
    lastRun: null
  })),
  saveSetting: vi.fn(async () => true),
  runAutoCleanupNow: vi.fn(async () => ({ status: 'cleared', ranAt: 1, archivedFiles: 4 })),
  pickArchiveDir: vi.fn(async () => '/Volumes/SSD/Archive')
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
  api.saveSetting.mockClear()
  api.runAutoCleanupNow.mockClear()
  api.getAutoCleanupStatus.mockClear()
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

describe('<DataPrivacyPanel/> automatic cleanup', () => {
  it('defaults to Off, hiding the folder/run controls', async () => {
    render(<DataPrivacyPanel />)
    await waitFor(() => expect(screen.getByText('Automatic cleanup')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Off' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('button', { name: /run now/i })).toBeNull()
  })

  it('choosing a window saves the config and re-reads main-sanitized status', async () => {
    const user = userEvent.setup()
    render(<DataPrivacyPanel />)
    await waitFor(() => expect(screen.getByText('Automatic cleanup')).toBeTruthy())

    await user.click(screen.getByRole('button', { name: '30 days' }))

    expect(api.saveSetting).toHaveBeenCalledWith('autoCleanup', {
      retentionDays: 30,
      archiveDir: null
    })
    // Saved, then re-fetched - main's sanitized copy is the source of truth.
    await waitFor(() => expect(api.getAutoCleanupStatus.mock.calls.length).toBeGreaterThan(1))
  })

  it('with retention on, offers the folder picker and Run now, and reports the last run', async () => {
    api.getAutoCleanupStatus.mockResolvedValue({
      config: { retentionDays: 30, archiveDir: null },
      lastRun: { status: 'cleared', ranAt: 1756100000000, archivedFiles: 12 }
    } as never)
    const user = userEvent.setup()
    render(<DataPrivacyPanel />)
    await waitFor(() => expect(screen.getByText(/no backup - choose a folder/i)).toBeTruthy())
    expect(screen.getByText(/12 files archived/i)).toBeTruthy()

    await user.click(screen.getByText(/no backup - choose a folder/i))
    expect(api.pickArchiveDir).toHaveBeenCalled()
    await waitFor(() =>
      expect(api.saveSetting).toHaveBeenCalledWith('autoCleanup', {
        retentionDays: 30,
        archiveDir: '/Volumes/SSD/Archive'
      })
    )

    await user.click(screen.getByRole('button', { name: /run now/i }))
    expect(api.runAutoCleanupNow).toHaveBeenCalledTimes(1)
  })

  it('a failed last run says nothing was deleted', async () => {
    api.getAutoCleanupStatus.mockResolvedValue({
      config: { retentionDays: 30, archiveDir: '/gone' },
      lastRun: { status: 'failed', ranAt: 1756100000000, error: 'drive unplugged' }
    } as never)
    render(<DataPrivacyPanel />)
    await waitFor(() =>
      expect(screen.getByText(/last run failed - nothing was deleted/i)).toBeTruthy()
    )
  })
})
