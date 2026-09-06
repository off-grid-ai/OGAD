import { ipcMain } from 'electron'
import type { OffGridApplication } from '@offgrid/application'
import { BACKUP_EXPORT_ALL_CHANNEL, BACKUP_IMPORT_CHANNEL } from '../../shared/backup-contracts'
import { createDesktopBackupComposition, type DesktopBackupEngine } from '../composition/backup'

type BackupHandler = (event: unknown) => Promise<unknown>

export type DesktopBackupCommands = Pick<DesktopBackupEngine, 'exportAll' | 'import'>

export interface BackupIpcBoundary {
  handle(channel: string, handler: BackupHandler): void
}

export function registerDesktopBackupIPC(
  ipc: BackupIpcBoundary,
  engine: DesktopBackupCommands
): void {
  ipc.handle(BACKUP_EXPORT_ALL_CHANNEL, () => engine.exportAll())
  ipc.handle(BACKUP_IMPORT_CHANNEL, () => engine.import())
}

export function setupDesktopBackupIPC(application: OffGridApplication): () => void {
  const backup = createDesktopBackupComposition(application)
  registerDesktopBackupIPC(ipcMain, backup.engine)
  return () => {
    ipcMain.removeHandler(BACKUP_EXPORT_ALL_CHANNEL)
    ipcMain.removeHandler(BACKUP_IMPORT_CHANNEL)
    backup.dispose()
  }
}
