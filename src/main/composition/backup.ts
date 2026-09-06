// Composition root: the shared portable backup engine over Desktop's SQLite, file, and archive ports.
import os from 'node:os'
import { app } from 'electron'
import { BackupEngine } from '@offgrid/sync/portable'
import type { OffGridApplication } from '@offgrid/application'
import { getDB } from '../database'
import { ensureRagStoreSchema } from '../rag/store'
import { DesktopBackupArchive } from '../backup/archive'
import { DesktopBackupDataPort } from '../backup/data-port'
import { BackupRestoreAdmission, startBackupRestoreRecovery } from '../backup/restore-admission'
import { DesktopBackupFileMapper } from '../backup/file-mapper'
import { DesktopBackupSink, type DesktopBackupDelivery } from '../backup/sink'
import type { DesktopBackupData, DesktopRestoreSummary } from '../backup/types'
import { registerDataDeletionGuard } from '../data-privacy'

export type DesktopBackupEngine = BackupEngine<
  DesktopBackupData,
  DesktopRestoreSummary,
  DesktopBackupDelivery
>

export interface DesktopBackupComposition {
  readonly engine: DesktopBackupEngine
  dispose(): void
}

export type DesktopBackupApplication = Pick<
  OffGridApplication,
  'workspaceContent' | 'snapshot' | 'subscribe'
>

export function createDesktopBackupComposition(
  application: DesktopBackupApplication
): DesktopBackupComposition {
  ensureRagStoreSchema()
  const admission = new BackupRestoreAdmission()
  const data = new DesktopBackupDataPort(getDB(), {
    workspaceContent: application.workspaceContent,
    restoreAdmission: admission
  })
  const stopRecovery = startBackupRestoreRecovery(admission, application, () =>
    data.resumePending()
  )
  const stopGuard = registerDataDeletionGuard('desktop:backup-restore', {
    scopes: ['chats', 'all'],
    suspend: () => admission.suspend(),
    resume: () => admission.resume()
  })
  const engine = new BackupEngine(
    data,
    new DesktopBackupFileMapper(),
    new DesktopBackupArchive({
      tempDir: os.tmpdir(),
      userDataDir: app.getPath('userData')
    }),
    new DesktopBackupSink(),
    () => new Date().toISOString()
  )
  return {
    engine,
    dispose: () => {
      stopGuard()
      stopRecovery()
    }
  }
}
