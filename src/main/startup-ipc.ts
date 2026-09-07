/**
 * The startup projection, published to every window.
 *
 * Registered BEFORE the first window: the shell now opens while domains are still starting, so the
 * renderer has to be able to ask "is the app up yet, and if not, what is missing" the moment it
 * loads. Blocking the window until the answer was always "yes" is the thing this replaces.
 */
import { ipcMain, BrowserWindow } from 'electron'
import { startupProjection, type StartupSnapshot } from './startup-projection'

export const STARTUP_STATUS_CHANNEL = 'app:startup-status'
export const STARTUP_STATUS_CHANGED_CHANNEL = 'app:startup-status-changed'

/** Register the read and the push. Returns the release for the projection subscription. */
export function registerStartupStatusIpc(): () => void {
  ipcMain.handle(STARTUP_STATUS_CHANNEL, () => startupProjection.snapshot())
  return startupProjection.subscribe((snapshot: StartupSnapshot) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      window.webContents.send(STARTUP_STATUS_CHANGED_CHANNEL, snapshot)
    }
  })
}
