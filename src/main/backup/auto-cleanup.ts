// Automatic history cleanup: the scheduled (Phase 2) reuse of the archive-then-clear
// seam. Instead of the manual save dialog, delivery is a verified copy into a fixed
// archive folder - or, with no folder configured, a plain prune with no archive.
// Same fail-closed rule: when a backup IS requested, a failed or unverifiable copy
// means nothing gets deleted.
//
// Electron-free: paths and the clear callback are injected, so the due-ness math,
// the folder delivery, and the ordering are all unit-testable against temp dirs.
// The Electron wiring (settings, scheduler, IPC) lives in retention-archive-ipc.ts.
import fs from 'node:fs'
import path from 'node:path'
import type {
  AutoCleanupConfigContract,
  AutoCleanupRunContract
} from '../../shared/backup-contracts'
import {
  archiveThenClear,
  collectCategoryFiles,
  stageRetentionArchive,
  type ArchiveDelivery
} from './retention-archive'

/** Once a day, with a margin so a drifting timer can't skip a whole day. */
export const AUTO_CLEANUP_INTERVAL_MS = 23.5 * 60 * 60 * 1000

export function cleanupDue(lastRunAt: number | null, now: number): boolean {
  return lastRunAt === null || now - lastRunAt >= AUTO_CLEANUP_INTERVAL_MS
}

/**
 * Deliver a staged ZIP into a fixed folder, verified: the copy must exist at the
 * staged size before we report success (success is what authorizes the prune).
 * A name collision gets a numeric suffix instead of overwriting an earlier archive.
 * Staging is removed on every path, mirroring DesktopBackupSink.
 */
export function folderDeliver(archiveDir: string) {
  return async (zipPath: string, suggestedName: string): Promise<ArchiveDelivery> => {
    try {
      await fs.promises.mkdir(archiveDir, { recursive: true })
      const parsed = path.parse(suggestedName)
      let dest = path.join(archiveDir, suggestedName)
      for (let n = 2; fs.existsSync(dest); n++) {
        dest = path.join(archiveDir, `${parsed.name}-${n}${parsed.ext}`)
      }
      await fs.promises.copyFile(zipPath, dest)
      const staged = await fs.promises.stat(zipPath)
      const copied = await fs.promises.stat(dest)
      if (copied.size !== staged.size) {
        await fs.promises.rm(dest, { force: true })
        throw new Error('The archive copy did not match the staged file.')
      }
      return { canceled: false, path: dest }
    } finally {
      await fs.promises.rm(zipPath, { force: true })
      await fs.promises.rmdir(path.dirname(zipPath)).catch(() => undefined)
    }
  }
}

export interface AutoCleanupRunOptions {
  config: AutoCleanupConfigContract
  userDataDir: string
  tempDir?: string
  /** The real category delete (clearCategory('captures', retentionDays)). */
  clear: () => Promise<{ success: boolean }>
  now?: number
}

/** One cleanup pass over screen captures. Pure orchestration - callers persist the result. */
export async function runAutoCleanup(opts: AutoCleanupRunOptions): Promise<AutoCleanupRunContract> {
  const ranAt = opts.now ?? Date.now()
  const days = opts.config.retentionDays
  if (!Number.isInteger(days) || days <= 0) return { status: 'off', ranAt }

  if (opts.config.archiveDir === null) {
    // Plain rolling window - the user chose no backup, so prune directly.
    const cleared = await opts.clear()
    return cleared.success
      ? { status: 'cleared', ranAt, archivedFiles: 0 }
      : { status: 'failed', ranAt, error: 'The prune failed.' }
  }

  const archiveDir = opts.config.archiveDir
  const result = await archiveThenClear({
    collect: () => collectCategoryFiles(opts.userDataDir, 'captures', days),
    stage: (files) =>
      stageRetentionArchive(files, {
        category: 'captures',
        olderThanDays: days,
        tempDir: opts.tempDir
      }),
    deliver: folderDeliver(archiveDir),
    clear: opts.clear
  })
  if (result.status === 'cleared') {
    return {
      status: 'cleared',
      ranAt,
      archivedFiles: result.archivedFiles,
      archivePath: result.archivePath
    }
  }
  // folderDeliver never cancels; normalize everything else to failed.
  return {
    status: 'failed',
    ranAt,
    error: result.status === 'failed' ? result.error : 'The archive was canceled.'
  }
}
