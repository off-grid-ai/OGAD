/**
 * The vision rail's supervisor bridge (R2-D2b UX half): lets the renderer watch
 * a running vision task and stop or pause it, and broadcasts the task's state +
 * step feed to the overlay. The kill switch also lives in the host as a global
 * Esc, but a user watching the overlay needs a visible Stop too - this is that
 * control, routed to the SAME guard so both paths halt one session.
 *
 * The guard is created per task inside the host; the host registers it here for
 * the task's lifetime. Thin wiring over the tested VisionGuard, kept out of the
 * host shell so the stop/pause/resume routing is testable with electron mocked.
 */
import { BrowserWindow, ipcMain } from 'electron'
import type { VisionGuard } from './vision-guard'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

let activeGuard: VisionGuard | null = null

/** The host calls this at task start with the task's guard, and calls the
 *  returned disposer at task end so a stale Stop cannot reach the next task. */
export function registerVisionSession(guard: VisionGuard): () => void {
  activeGuard = guard
  return () => {
    if (activeGuard === guard) {
      activeGuard = null
    }
  }
}

/** Push a step-feed line to the overlay. */
export function emitVisionStep(taskId: string, note: string): void {
  broadcast('vision:step', { taskId, note })
}

/** Warn the chat, at QUEUE time, that a computer-use task was queued on a
 *  non-grounder - so the user sees it before approving, not only once the rail
 *  runs. The chat's grounder nudge subscribes to this. */
export function emitVisionNotice(notice: string): void {
  broadcast('vision:notice', { notice })
}

/** Push the task lifecycle state to the overlay. `notice` warns (never blocks)
 *  when the loaded model is not a grounder - the rail stays model-agnostic. */
export function emitVisionState(state: {
  taskId: string
  goal: string
  status: 'running' | 'paused' | 'done' | 'failed'
  summary?: string
  notice?: string
}): void {
  broadcast('vision:task-state', state)
}

/** Fail-closed parse of a renderer supervisor command. */
export function parseVisionCommand(input: unknown): 'stop' | 'pause' | 'resume' | null {
  return input === 'stop' || input === 'pause' || input === 'resume' ? input : null
}

export function registerVisionIpc(): void {
  ipcMain.handle('vision:control', (_e, command: unknown) => {
    const parsed = parseVisionCommand(command)
    if (!parsed || !activeGuard) {
      return false
    }
    if (parsed === 'stop') {
      activeGuard.halt('stopped from the overlay')
    } else if (parsed === 'pause') {
      activeGuard.pauseForUser('paused from the overlay')
    } else {
      activeGuard.resume()
    }
    return true
  })
}
