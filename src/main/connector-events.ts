import { BrowserWindow } from 'electron'

/** Tell every renderer that a connector's status changed, so an open account card reloads. */
export function notifyConnectorsChanged(id: number): void {
  try {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('mcp:connectors-changed', { id })
    }
  } catch {
    /* no windows (a headless host): nothing to tell */
  }
}
