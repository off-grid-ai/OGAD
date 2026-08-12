// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackupRestoreSection } from '../BackupRestoreSection'

/**
 * Exporting and restoring a backup, as the user experiences it.
 *
 * A backup is the one feature whose whole value is that the user can trust what it tells them. "Backup
 * saved" when nothing was written, or a silent failure that looks like success, is worse than an error -
 * they would find out when they needed the backup and it was not there.
 *
 * So these tests drive the real component through real clicks and assert what it SAYS: the path it saved
 * to, an accurate count of what a restore added, a cancellation reported as a cancellation, and a failure
 * announced as an alert rather than dressed up as success. Only the preload bridge is faked - it is the
 * process boundary.
 */

const api = {
  exportBackup: vi.fn(),
  importBackup: vi.fn()
}

const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const summary = (overrides: Record<string, number> = {}): Record<string, number> => ({
  projectsAdded: 0,
  conversationsAdded: 0,
  messagesAdded: 0,
  documentsAdded: 0,
  ...overrides
})

describe('the backup section in Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as unknown as { window: { api: unknown } }).window.api = api
  })

  afterEach(() => cleanup())

  it('offers both halves, described by what they do to the user-s data', async () => {
    render(<BackupRestoreSection />)

    expect(screen.getByRole('button', { name: /Create backup/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Choose backup/ })).toBeTruthy()
    // The restore copy promises that existing data is untouched, which is what makes the button safe to
    // press. If the behaviour ever stopped being additive this line would have to change with it.
    expect(screen.getByText(/Existing data stays unchanged/)).toBeTruthy()
  })

  it('says where the backup was saved, so the user can go and find it', async () => {
    const user = userEvent.setup()
    api.exportBackup.mockResolvedValue({ canceled: false, path: '/Users/someone/Desktop/backup.zip' })
    render(<BackupRestoreSection />)

    await user.click(screen.getByRole('button', { name: /Create backup/ }))

    expect(
      await screen.findByText('Backup saved to /Users/someone/Desktop/backup.zip.')
    ).toBeTruthy()
    // A status, not an alert: nothing went wrong, so it must not be announced as a problem.
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('still confirms a save when the path is not reported back', async () => {
    const user = userEvent.setup()
    api.exportBackup.mockResolvedValue({ canceled: false })
    render(<BackupRestoreSection />)

    await user.click(screen.getByRole('button', { name: /Create backup/ }))

    // Saying "Backup saved to undefined." would look like a bug in a message the user is meant to trust.
    expect(await screen.findByText('Backup saved.')).toBeTruthy()
  })

  it('reports a cancelled export as cancelled, not as saved', async () => {
    const user = userEvent.setup()
    api.exportBackup.mockResolvedValue({ canceled: true })
    render(<BackupRestoreSection />)

    await user.click(screen.getByRole('button', { name: /Create backup/ }))

    expect(await screen.findByText('Backup canceled.')).toBeTruthy()
  })

  it('treats no answer at all as a cancellation rather than a success', async () => {
    const user = userEvent.setup()
    api.exportBackup.mockResolvedValue(null)
    render(<BackupRestoreSection />)

    await user.click(screen.getByRole('button', { name: /Create backup/ }))

    expect(await screen.findByText('Backup canceled.')).toBeTruthy()
  })

  it('shows progress on the button and blocks BOTH actions while it works', async () => {
    const user = userEvent.setup()
    const pending = deferred<{ canceled: boolean }>()
    api.exportBackup.mockReturnValue(pending.promise)
    render(<BackupRestoreSection />)

    await user.click(screen.getByRole('button', { name: /Create backup/ }))

    // Both disabled, not just the one pressed: an export and a restore running at once would have two
    // things writing the same library.
    expect(await screen.findByRole('button', { name: /Creating backup/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Choose backup/ })).toHaveProperty('disabled', true)

    pending.resolve({ canceled: true })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Create backup/ })).toHaveProperty('disabled', false)
    )
  })

  it('counts exactly what a restore added', async () => {
    const user = userEvent.setup()
    api.importBackup.mockResolvedValue(
      summary({ projectsAdded: 2, conversationsAdded: 1, messagesAdded: 14, documentsAdded: 3 })
    )
    render(<BackupRestoreSection />)

    await user.click(screen.getByRole('button', { name: /Choose backup/ }))

    // Singular where it should be singular. A count is the only evidence the user gets that the restore did
    // what they hoped, so "1 chats" undermines the one message that matters.
    expect(
      await screen.findByText('Restored 2 projects, 1 chat, 14 messages, and 3 documents.')
    ).toBeTruthy()
  })

  it('says plainly when a backup held nothing new, instead of claiming a restore', async () => {
    const user = userEvent.setup()
    api.importBackup.mockResolvedValue(summary())
    render(<BackupRestoreSection />)

    await user.click(screen.getByRole('button', { name: /Choose backup/ }))

    // Restoring the same backup twice is normal. "Restored 0 projects, 0 chats..." reads as a failure; this
    // tells the user the truth, which is that they have lost nothing and need do nothing.
    expect(
      await screen.findByText('Backup checked. This device already has everything in it.')
    ).toBeTruthy()
  })

  it('reports a cancelled restore as cancelled', async () => {
    const user = userEvent.setup()
    api.importBackup.mockResolvedValue(null)
    render(<BackupRestoreSection />)

    await user.click(screen.getByRole('button', { name: /Choose backup/ }))

    expect(await screen.findByText('Restore canceled.')).toBeTruthy()
  })

  it('announces a failure as an alert, carrying the reason the app gave', async () => {
    const user = userEvent.setup()
    api.importBackup.mockRejectedValue(new Error('This backup contains an unsafe file path.'))
    render(<BackupRestoreSection />)

    await user.click(screen.getByRole('button', { name: /Choose backup/ }))

    // role=alert, so a screen reader interrupts with it - and the specific reason, because "it failed" gives
    // the user nothing to act on. This message comes from the archive's own safety check.
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('This backup contains an unsafe file path.')
  })

  it('falls back to a readable message when the failure is not an Error', async () => {
    const user = userEvent.setup()
    api.importBackup.mockRejectedValue('a string thrown from somewhere')
    render(<BackupRestoreSection />)

    await user.click(screen.getByRole('button', { name: /Choose backup/ }))

    // An IPC boundary can reject with anything. The user still gets a sentence rather than a blank alert.
    expect((await screen.findByRole('alert')).textContent).toBe('The backup operation failed.')
  })

  it('recovers after a failure: the next attempt clears the old error', async () => {
    const user = userEvent.setup()
    api.importBackup.mockRejectedValueOnce(new Error('disk was full'))
    api.importBackup.mockResolvedValueOnce(summary({ projectsAdded: 1 }))
    render(<BackupRestoreSection />)

    await user.click(screen.getByRole('button', { name: /Choose backup/ }))
    expect(await screen.findByRole('alert')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /Choose backup/ }))

    // The old failure must not linger beside a new success - a stale red message next to a completed restore
    // is the user's evidence contradicting itself.
    expect(
      await screen.findByText('Restored 1 project, 0 chats, 0 messages, and 0 documents.')
    ).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('re-enables the buttons after a failure, so the user can try again', async () => {
    const user = userEvent.setup()
    api.exportBackup.mockRejectedValue(new Error('nope'))
    render(<BackupRestoreSection />)

    await user.click(screen.getByRole('button', { name: /Create backup/ }))

    // The finally clause earns its keep here: a failed export that left the buttons disabled would need an
    // app restart to retry.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Create backup/ })).toHaveProperty('disabled', false)
    )
  })

  it('says nothing at all before the user has done anything', () => {
    render(<BackupRestoreSection />)

    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
