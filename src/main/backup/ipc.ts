import { ipcMain } from 'electron'
import { BACKUP_EXPORT_ALL_CHANNEL, BACKUP_IMPORT_CHANNEL } from '../../shared/backup-contracts'
import { createDesktopBackupEngine, type DesktopBackupEngine } from '.'

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

export function setupDesktopBackupIPC(): void {
  registerDesktopBackupIPC(ipcMain, createDesktopBackupEngine())
}
