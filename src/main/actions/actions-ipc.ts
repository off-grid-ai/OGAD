/**
 * The actions IPC surface (Approval UX v2, R2-B3). Thin Electron wiring over
 * tested modules: the inline gate surface broadcasts pending cards to the
 * chat, worker outcomes broadcast with their undoability, and the renderer
 * resolves gates / requests undo through fail-closed parsers.
 *
 * Registered once at app setup, AFTER the DB exists (it builds the runtime).
 */
import { BrowserWindow, ipcMain } from 'electron'
import { parseActionRecord } from '@offgrid/use'
import { parseGateDecision, resolveActionGate } from './gate-host'
import { getActionsRuntime } from './use-runtime'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

export function registerActionsIpc(): () => void {
  const runtime = getActionsRuntime()
  ipcMain.handle('actions:get-projection', () => runtime.snapshot())
  const stopProjection = runtime.subscribe((snapshot) => {
    broadcast('actions:projection-changed', snapshot)
  })
  const stopOutcomes = runtime.onOutcome(({ outcome, undoable }) => {
    broadcast('actions:outcome', { ...outcome, undoable })
  })

  ipcMain.handle('actions:resolve-gate', (_event, actionId: unknown, decision: unknown) => {
    const parsed = parseGateDecision(decision)
    if (typeof actionId !== 'string' || !parsed) {
      return false
    }
    return resolveActionGate(actionId, parsed)
  })

  ipcMain.handle('actions:undo', async (_event, record: unknown) => {
    const parsed = parseActionRecord(record)
    if (!parsed.ok) {
      return { ok: false, detail: 'not a valid action record' }
    }
    return runtime.undo(parsed.value)
  })

  ipcMain.handle('actions:retry', (_event, actionId: unknown) => {
    if (typeof actionId !== 'string' || actionId.length === 0) {
      return {
        ok: false,
        failure: { kind: 'runtime', operation: 'retry', message: 'invalid action id' }
      }
    }
    return runtime.retry(actionId)
  })

  return () => {
    stopProjection()
    stopOutcomes()
  }
}
