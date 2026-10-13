// Web Use and Computer Use settings have one home, the desktop's settings store, and two places
// to change them: the desktop's Settings and the paired browser's. Every window hears about a
// change, wherever it came from, so the screens never show different values.

import { BrowserWindow } from 'electron'

export const TASK_SETTINGS_CHANGED = 'task-settings:changed'

export function announceTaskSettings(key: string, value: unknown): void {
  // The model manager also runs without Electron (no windows to tell), as runtime-env allows.
  if (typeof BrowserWindow === 'undefined') return
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(TASK_SETTINGS_CHANGED, { key, value })
  }
}
