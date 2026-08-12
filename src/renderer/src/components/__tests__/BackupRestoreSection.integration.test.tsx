// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackupRestoreSection } from '../BackupRestoreSection'

describe('desktop Backup & Restore settings', () => {
  const exportBackup = vi.fn()
  const importBackup = vi.fn()

  beforeEach(() => {
    exportBackup.mockReset()
    importBackup.mockReset()
    exportBackup.mockResolvedValue({
      canceled: false,
      path: '/Users/tester/Documents/offgrid-backup.zip'
    })
    importBackup.mockResolvedValue({
      projectsAdded: 2,
      conversationsAdded: 3,
      messagesAdded: 8,
      documentsAdded: 1
    })
    ;(globalThis as unknown as { window: { api: unknown } }).window.api = {
      exportBackup,
      importBackup
    }
  })

  afterEach(cleanup)

  it('creates and additively restores a portable backup from Settings', async () => {
    const user = userEvent.setup()
    render(<BackupRestoreSection />)

    expect(screen.getByText('Create a portable backup')).toBeTruthy()
    expect(
      screen.getByText(
        'Add missing chats, projects, and knowledge files. Existing data stays unchanged.'
      )
    ).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Create backup' }))
    expect(exportBackup).toHaveBeenCalledTimes(1)
    expect((await screen.findByRole('status')).textContent).toBe(
      'Backup saved to /Users/tester/Documents/offgrid-backup.zip.'
    )

    await user.click(screen.getByRole('button', { name: 'Choose backup' }))
    expect(importBackup).toHaveBeenCalledTimes(1)
    expect((await screen.findByRole('status')).textContent).toBe(
      'Restored 2 projects, 3 chats, 8 messages, and 1 document.'
    )
  })

  it('reports cancellation and restore failures without claiming data changed', async () => {
    exportBackup.mockResolvedValue({ canceled: true })
    importBackup.mockRejectedValue(new Error('This backup has an unsupported format.'))
    const user = userEvent.setup()
    render(<BackupRestoreSection />)

    await user.click(screen.getByRole('button', { name: 'Create backup' }))
    expect((await screen.findByRole('status')).textContent).toBe('Backup canceled.')

    await user.click(screen.getByRole('button', { name: 'Choose backup' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This backup has an unsupported format.'
    )
  })

  it('explains when a valid backup contains no new data', async () => {
    importBackup.mockResolvedValue({
      projectsAdded: 0,
      conversationsAdded: 0,
      messagesAdded: 0,
      documentsAdded: 0
    })
    const user = userEvent.setup()
    render(<BackupRestoreSection />)

    await user.click(screen.getByRole('button', { name: 'Choose backup' }))
    expect((await screen.findByRole('status')).textContent).toBe(
      'Backup checked. This device already has everything in it.'
    )
  })
})
