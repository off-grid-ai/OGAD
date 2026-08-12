import os from 'node:os'
import { app } from 'electron'
import { BackupEngine } from '@offgrid/sync/portable'
import { getDB } from '../database'
import { ensureRagStoreSchema } from '../rag/store'
import { DesktopBackupArchive } from './archive'
import { DesktopBackupDataPort } from './data-port'
import { DesktopBackupFileMapper } from './file-mapper'
import { DesktopBackupSink, type DesktopBackupDelivery } from './sink'
import type { DesktopBackupData, DesktopRestoreSummary } from './types'

export type DesktopBackupEngine = BackupEngine<
  DesktopBackupData,
  DesktopRestoreSummary,
  DesktopBackupDelivery
>

export function createDesktopBackupEngine(): DesktopBackupEngine {
  ensureRagStoreSchema()
  return new BackupEngine(
    new DesktopBackupDataPort(getDB()),
    new DesktopBackupFileMapper(),
    new DesktopBackupArchive({
      tempDir: os.tmpdir(),
      userDataDir: app.getPath('userData')
    }),
    new DesktopBackupSink(),
    () => new Date().toISOString()
  )
}

export type { DesktopBackupData, DesktopRestoreSummary, DesktopBackupDelivery }
