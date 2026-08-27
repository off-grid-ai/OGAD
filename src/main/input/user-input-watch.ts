/**
 * The "pause when the user touches the machine" defense (SAFETY_REVIEW: any
 * user touch pauses the supervised run until they resume). Two strategies
 * behind one seam:
 *
 *  - uiohook-napi (OPTIONAL native addon, same pattern as nut-js): global
 *    mouse + keyboard events. Keyboard coverage needs it - and on newer macOS
 *    the Input Monitoring grant.
 *  - cursor polling (always available, no deps): Electron's
 *    screen.getCursorScreenPoint() every 150ms - catches the user moving the
 *    mouse, which is the dominant takeover signal. Keyboard is not visible to
 *    this strategy; the Esc kill switch still works regardless (globalShortcut).
 *
 * Events that are the rail's own output are filtered by the synthetic tracker
 * (one owner: input/synthetic-tracker.ts), and interactions with our own
 * windows (the supervisor overlay's buttons) never count as a takeover.
 */
import { BrowserWindow, screen } from 'electron'
import {
  DEFAULT_USER_INPUT_RULE,
  insideAnyWindow,
  isUserInput,
  resetSynthetic,
  syntheticSnapshot,
  type InputEvent
} from './synthetic-tracker'

const POLL_MS = 150

interface UioHookApi {
  uIOhook: {
    on(event: string, handler: (e: { x?: number; y?: number }) => void): void
    removeAllListeners(event?: string): void
    start(): void
    stop(): void
  }
}

/** Load the OPTIONAL global-input addon; absent/unbuilt -> null (poll fallback). */
function loadInputHook(): UioHookApi['uIOhook'] | null {
  try {
    const load = (m: string): UioHookApi => (require as NodeRequire)(m) as UioHookApi
    return load('uiohook-napi').uIOhook
  } catch {
    return null
  }
}

function appWindowRects(): { x: number; y: number; width: number; height: number }[] {
  return BrowserWindow.getAllWindows()
    .filter((w) => !w.isDestroyed() && w.isVisible())
    .map((w) => w.getBounds())
}

function userEvent(event: InputEvent): boolean {
  if (event.point && insideAnyWindow(event.point, appWindowRects())) {
    return false
  }
  return isUserInput(event, syntheticSnapshot(), DEFAULT_USER_INPUT_RULE)
}

/**
 * Watch for human input for the duration of a supervised run. `onUserInput`
 * may fire more than once (pause is idempotent; a takeover after a resume
 * pauses again). Returns stop(). Also resets the synthetic tracker so a run
 * starts from a clean slate.
 *
 * `strategy` exists for tests and diagnostics: 'poll' skips the native hook
 * (a test must never start a real global input hook on the machine).
 */
export function startUserInputWatch(
  onUserInput: (why: string) => void,
  strategy: 'auto' | 'poll' = 'auto'
): () => void {
  resetSynthetic()
  const hook = strategy === 'auto' ? loadInputHook() : null
  if (hook) {
    const onMouse = (e: { x?: number; y?: number }): void => {
      const point =
        typeof e.x === 'number' && typeof e.y === 'number' ? { x: e.x, y: e.y } : undefined
      if (userEvent({ kind: 'mouse', at: Date.now(), ...(point ? { point } : {}) })) {
        onUserInput('you moved the mouse')
      }
    }
    const onKey = (): void => {
      if (userEvent({ kind: 'key', at: Date.now() })) {
        onUserInput('you typed')
      }
    }
    hook.on('mousemove', onMouse)
    hook.on('mousedown', onMouse)
    hook.on('wheel', onMouse)
    hook.on('keydown', onKey)
    try {
      hook.start()
    } catch {
      /* hook failed to start (missing OS grant) - fall through to polling below */
      return startCursorPollWatch(onUserInput)
    }
    return () => {
      try {
        hook.removeAllListeners('mousemove')
        hook.removeAllListeners('mousedown')
        hook.removeAllListeners('wheel')
        hook.removeAllListeners('keydown')
        hook.stop()
      } catch {
        /* already stopped */
      }
    }
  }
  return startCursorPollWatch(onUserInput)
}

function startCursorPollWatch(onUserInput: (why: string) => void): () => void {
  const timer = setInterval(() => {
    let point: { x: number; y: number }
    try {
      point = screen.getCursorScreenPoint()
    } catch {
      return
    }
    if (userEvent({ kind: 'mouse', at: Date.now(), point })) {
      onUserInput('you moved the mouse')
    }
  }, POLL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
