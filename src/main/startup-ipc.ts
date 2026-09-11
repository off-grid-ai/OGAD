import { BrowserWindow, ipcMain } from 'electron'
import { startupProjection } from './startup-projection'

const STARTUP_STATUS_CHANNEL = 'app:startup-status'
const STARTUP_STATUS_CHANGED_CHANNEL = 'app:startup-status-changed'

export function registerStartupStatusIpc(): () => void {
  ipcMain.handle(STARTUP_STATUS_CHANNEL, () => startupProjection.snapshot())
  const unsubscribe = startupProjection.subscribe((snapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(STARTUP_STATUS_CHANGED_CHANNEL, snapshot)
      }
    }
  })

  return () => {
    unsubscribe()
    ipcMain.removeHandler(STARTUP_STATUS_CHANNEL)
  }
}
