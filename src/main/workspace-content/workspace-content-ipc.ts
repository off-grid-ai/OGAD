import { BrowserWindow, ipcMain } from 'electron'
import { desktopWorkspaceContentMigrationRuntime } from './migration-runtime'

const GET_MIGRATION_SNAPSHOT_CHANNEL = 'workspace-content:migration:get-snapshot'
const RETRY_MIGRATION_CHANNEL = 'workspace-content:migration:retry'
const MIGRATION_SNAPSHOT_CHANGED_CHANNEL = 'workspace-content:migration:snapshot-changed'

const HANDLER_CHANNELS = [GET_MIGRATION_SNAPSHOT_CHANNEL, RETRY_MIGRATION_CHANNEL] as const

let releaseRegistration: (() => void) | null = null

/** Thin IPC projection for the process-wide workspace-content migration runtime. */
export function registerWorkspaceContentMigrationIpc(): () => void {
  if (releaseRegistration) return releaseRegistration

  ipcMain.handle(GET_MIGRATION_SNAPSHOT_CHANNEL, () =>
    desktopWorkspaceContentMigrationRuntime.getSnapshot()
  )
  ipcMain.handle(RETRY_MIGRATION_CHANNEL, () => desktopWorkspaceContentMigrationRuntime.start())

  const stopSubscription = desktopWorkspaceContentMigrationRuntime.subscribe((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(MIGRATION_SNAPSHOT_CHANGED_CHANNEL, snapshot)
    }
  })

  releaseRegistration = function stop(): void {
    stopSubscription()
    for (const channel of HANDLER_CHANNELS) ipcMain.removeHandler(channel)
    releaseRegistration = null
  }
  return releaseRegistration
}
