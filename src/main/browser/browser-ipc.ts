/**
 * The browser rail's IPC (R2-C2/C3): the watched pane resolves a takeover
 * through here, and the coordinator's park requests are broadcast to the pane.
 * Thin wiring over the tested TakeoverCoordinator - kept out of the host shell
 * so it can be tested with electron mocked.
 */
import { BrowserWindow, ipcMain } from 'electron'
import { getTakeoverCoordinator, type TakeoverOutcome } from './takeover'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

/** Fail-closed parse of the pane's verdict: only the two known outcomes pass. */
export function parseTakeoverOutcome(input: unknown): TakeoverOutcome | null {
  return input === 'resumed' || input === 'cancelled' ? input : null
}

export function registerBrowserIpc(): void {
  const coordinator = getTakeoverCoordinator()
  // The pane renders parks and hides them when they clear.
  coordinator.registerSurface(
    (request) => broadcast('browser:takeover', request),
    (taskId) => broadcast('browser:takeover-cleared', { taskId })
  )
  ipcMain.handle('browser:resolve-takeover', (_e, taskId: unknown, outcome: unknown) => {
    const parsed = parseTakeoverOutcome(outcome)
    if (typeof taskId !== 'string' || !parsed) {
      return false
    }
    return coordinator.resolve(taskId, parsed)
  })
}
