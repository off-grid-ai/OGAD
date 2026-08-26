// Electron wiring for archive-before-delete and the scheduled automatic cleanup:
// binds the pure orchestrations to the real userData dir, the save-dialog sink /
// archive folder, the settings store, and clearCategory.
import os from 'node:os'
import { app, BrowserWindow, dialog } from 'electron'
import {
  AUTO_CLEANUP_DEFAULTS,
  AUTO_CLEANUP_SETTING_KEY,
  type AutoCleanupConfigContract,
  type AutoCleanupRunContract,
  type AutoCleanupStatusContract
} from '../../shared/backup-contracts'
import { ARCHIVABLE_CATEGORIES, type DataCategoryId } from '../data-categories'
import { clearCategory } from '../data-privacy'
import { getSetting, saveSetting } from '../database'
import { cleanupDue, runAutoCleanup } from './auto-cleanup'
import {
  archiveThenClear,
  collectCategoryFiles,
  stageRetentionArchive,
  type ArchiveClearResult
} from './retention-archive'
import { DesktopBackupSink } from './sink'

export async function archiveThenClearCategory(
  id: string,
  olderThanDays?: number
): Promise<ArchiveClearResult> {
  if (!(ARCHIVABLE_CATEGORIES as readonly string[]).includes(id)) {
    return { status: 'failed', error: `Category "${id}" cannot be archived before delete.` }
  }
  const category = id as DataCategoryId
  const sink = new DesktopBackupSink()
  return archiveThenClear({
    collect: () => collectCategoryFiles(app.getPath('userData'), category, olderThanDays),
    stage: (files) =>
      stageRetentionArchive(files, { category, olderThanDays, tempDir: os.tmpdir() }),
    deliver: (zipPath, suggestedName) => sink.deliverFile(zipPath, suggestedName),
    clear: () => clearCategory(category, olderThanDays)
  })
}

// --- Automatic history cleanup (Phase 2) -----------------------------------

const AUTO_CLEANUP_STATE_KEY = 'autoCleanupLastRun'

/** Sanitize whatever is in settings into a valid config - the renderer writes this
 *  key directly via settings:save, so never trust its shape. */
export function readAutoCleanupConfig(): AutoCleanupConfigContract {
  const raw = getSetting<Partial<AutoCleanupConfigContract>>(
    AUTO_CLEANUP_SETTING_KEY,
    AUTO_CLEANUP_DEFAULTS
  )
  const days = Number(raw?.retentionDays)
  return {
    retentionDays: Number.isInteger(days) && days > 0 && days <= 3650 ? days : 0,
    archiveDir:
      typeof raw?.archiveDir === 'string' && raw.archiveDir.length > 0 ? raw.archiveDir : null
  }
}

export function getAutoCleanupStatus(): AutoCleanupStatusContract {
  return {
    config: readAutoCleanupConfig(),
    lastRun: getSetting<AutoCleanupRunContract | null>(AUTO_CLEANUP_STATE_KEY, null)
  }
}

let cleanupRunning = false

/** One cleanup pass now (manual "Run now" or the scheduler). Persists the result. */
export async function runAutoCleanupNow(): Promise<AutoCleanupRunContract> {
  if (cleanupRunning)
    return { status: 'failed', ranAt: Date.now(), error: 'A cleanup is already running.' }
  cleanupRunning = true
  try {
    const config = readAutoCleanupConfig()
    const result = await runAutoCleanup({
      config,
      userDataDir: app.getPath('userData'),
      tempDir: os.tmpdir(),
      clear: () => clearCategory('captures', config.retentionDays)
    })
    if (result.status !== 'off') saveSetting(AUTO_CLEANUP_STATE_KEY, result)
    return result
  } finally {
    cleanupRunning = false
  }
}

export async function maybeRunScheduledCleanup(): Promise<void> {
  try {
    const { config, lastRun } = getAutoCleanupStatus()
    if (config.retentionDays <= 0) return
    if (!cleanupDue(lastRun?.ranAt ?? null, Date.now())) return
    const result = await runAutoCleanupNow()
    if (result.status === 'failed') console.error('[auto-cleanup] run failed:', result.error)
  } catch (e) {
    console.error('[auto-cleanup] scheduled run crashed:', e)
  }
}

/** Daily cadence via an hourly due-check, plus one check shortly after startup so a
 *  Mac that sleeps through the timer still cleans up on the next launch. */
export function setupAutoCleanupScheduler(): void {
  setTimeout(() => void maybeRunScheduledCleanup(), 90_000)
  setInterval(() => void maybeRunScheduledCleanup(), 60 * 60_000)
}

/** IPC registration over an injectable boundary (same seam as backup/ipc.ts), so the
 *  channel->handler map is testable without Electron's real ipcMain. */
export interface RetentionIpcBoundary {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors Electron's ipcMain.handle signature
  handle(channel: string, handler: (event: unknown, ...args: any[]) => unknown): void
}

export function registerRetentionIpc(ipc: RetentionIpcBoundary): void {
  ipc.handle('data:archive-clear', (_e, id: string, olderThanDays?: number) =>
    archiveThenClearCategory(id, olderThanDays)
  )
  ipc.handle('data:auto-cleanup-status', () => getAutoCleanupStatus())
  ipc.handle('data:auto-cleanup-run', () => runAutoCleanupNow())
  ipc.handle('data:pick-archive-dir', () => pickArchiveDir())
}

/** Native folder picker for the archive destination. Returns null when canceled. */
export async function pickArchiveDir(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Choose a folder for capture archives',
    properties: ['openDirectory', 'createDirectory']
  }
  const owner = BrowserWindow.getFocusedWindow()
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}
