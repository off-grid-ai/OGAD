// The Electron wiring layer, tested at its true boundaries: electron (app paths,
// dialog), the settings store, and clearCategory are mocked; everything between -
// config sanitization, state persistence, the concurrency guard, the category
// refusal, and the archive->clear ordering against REAL temp files - runs for real.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({
  userDataDir: '',
  settings: new Map<string, unknown>(),
  clearCalls: [] as { id: string; olderThanDays?: number }[],
  clearResult: { success: true },
  dialogResult: { canceled: true, filePaths: [] as string[] }
}))

vi.mock('electron', () => ({
  app: { getPath: () => boundary.userDataDir },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => boundary.dialogResult }
}))

vi.mock('../../database', () => ({
  getSetting: <T>(key: string, dflt: T): T =>
    boundary.settings.has(key) ? (boundary.settings.get(key) as T) : dflt,
  saveSetting: (key: string, value: unknown): void => {
    boundary.settings.set(key, value)
  }
}))

vi.mock('../../data-privacy', () => ({
  clearCategory: async (id: string, olderThanDays?: number) => {
    boundary.clearCalls.push({ id, olderThanDays })
    return boundary.clearResult
  }
}))

import {
  archiveThenClearCategory,
  getAutoCleanupStatus,
  pickArchiveDir,
  readAutoCleanupConfig,
  runAutoCleanupNow
} from '../retention-archive-ipc'

beforeEach(() => {
  boundary.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ipc-ud-'))
  boundary.settings.clear()
  boundary.clearCalls = []
  boundary.clearResult = { success: true }
  boundary.dialogResult = { canceled: true, filePaths: [] }
})
afterEach(() => {
  fs.rmSync(boundary.userDataDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('archiveThenClearCategory', () => {
  it('refuses a category that is not archivable, touching nothing', async () => {
    const result = await archiveThenClearCategory('chats', 7)
    expect(result.status).toBe('failed')
    expect(boundary.clearCalls).toEqual([])
  })

  it('with nothing to archive it clears directly (no dialog involved)', async () => {
    const result = await archiveThenClearCategory('captures', 7)
    expect(result).toMatchObject({ status: 'cleared', archivedFiles: 0 })
    expect(boundary.clearCalls).toEqual([{ id: 'captures', olderThanDays: 7 }])
  })
})

describe('readAutoCleanupConfig (sanitizes whatever the renderer wrote)', () => {
  it('defaults to off with no folder', () => {
    expect(readAutoCleanupConfig()).toEqual({ retentionDays: 0, archiveDir: null })
  })

  it('rejects junk shapes instead of trusting them', () => {
    boundary.settings.set('autoCleanup', { retentionDays: 'soon', archiveDir: 42 })
    expect(readAutoCleanupConfig()).toEqual({ retentionDays: 0, archiveDir: null })
    boundary.settings.set('autoCleanup', { retentionDays: -5, archiveDir: '' })
    expect(readAutoCleanupConfig()).toEqual({ retentionDays: 0, archiveDir: null })
    boundary.settings.set('autoCleanup', { retentionDays: 999999, archiveDir: null })
    expect(readAutoCleanupConfig()).toEqual({ retentionDays: 0, archiveDir: null })
  })

  it('passes a valid config through', () => {
    boundary.settings.set('autoCleanup', { retentionDays: 30, archiveDir: '/Volumes/SSD' })
    expect(readAutoCleanupConfig()).toEqual({ retentionDays: 30, archiveDir: '/Volumes/SSD' })
  })
})

describe('runAutoCleanupNow', () => {
  it('is a no-op when retention is off, and persists nothing', async () => {
    const result = await runAutoCleanupNow()
    expect(result.status).toBe('off')
    expect(boundary.settings.has('autoCleanupLastRun')).toBe(false)
    expect(boundary.clearCalls).toEqual([])
  })

  it('runs the prune and persists the result as the last run', async () => {
    boundary.settings.set('autoCleanup', { retentionDays: 30, archiveDir: null })
    const result = await runAutoCleanupNow()
    expect(result.status).toBe('cleared')
    expect(boundary.clearCalls).toEqual([{ id: 'captures', olderThanDays: 30 }])
    expect(getAutoCleanupStatus().lastRun).toMatchObject({ status: 'cleared' })
  })

  it('archives real old captures into the configured folder before clearing', async () => {
    const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ipc-arc-'))
    try {
      const captures = path.join(boundary.userDataDir, 'captures')
      fs.mkdirSync(captures, { recursive: true })
      const old = new Date(Date.now() - 60 * 86_400_000)
      fs.writeFileSync(path.join(captures, 'old.png'), 'OLD')
      fs.utimesSync(path.join(captures, 'old.png'), old, old)
      boundary.settings.set('autoCleanup', { retentionDays: 30, archiveDir })

      const result = await runAutoCleanupNow()

      expect(result).toMatchObject({ status: 'cleared', archivedFiles: 1 })
      expect(fs.readdirSync(archiveDir)).toHaveLength(1)
      expect(boundary.clearCalls).toEqual([{ id: 'captures', olderThanDays: 30 }])
    } finally {
      fs.rmSync(archiveDir, { recursive: true, force: true })
    }
  })

  it('never runs two cleanups at once', async () => {
    boundary.settings.set('autoCleanup', { retentionDays: 30, archiveDir: null })
    const [first, second] = await Promise.all([runAutoCleanupNow(), runAutoCleanupNow()])
    const statuses = [first.status, second.status].sort()
    expect(statuses).toEqual(['cleared', 'failed'])
    expect(boundary.clearCalls).toHaveLength(1)
  })
})

describe('pickArchiveDir', () => {
  it('returns null when the dialog is canceled', async () => {
    expect(await pickArchiveDir()).toBeNull()
  })

  it('returns the chosen folder', async () => {
    boundary.dialogResult = { canceled: false, filePaths: ['/Volumes/SSD/Archive'] }
    expect(await pickArchiveDir()).toBe('/Volumes/SSD/Archive')
  })
})
