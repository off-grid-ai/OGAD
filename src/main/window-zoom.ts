import type { BrowserWindow, Input } from 'electron'

export type ZoomIntent = 'in' | 'out' | 'reset'

export const WINDOW_ZOOM_LEVEL_SETTING = 'windowZoomLevel'

const ZOOM_STEP = 0.5
const ZOOM_MIN = -3
const ZOOM_MAX = 5

/**
 * Cmd/Ctrl with =, +, - or 0. The app draws no menu bar, so the roles that carry these are absent.
 * The physical key code is matched first: the minus key's `key` differs across layouts and
 * modifiers, and it is the one that failed.
 */
export function zoomIntentForInput(
  input: Pick<Input, 'type' | 'key' | 'meta' | 'control' | 'alt'> & { code?: string }
): ZoomIntent | null {
  if (input.type !== 'keyDown' || input.alt) return null
  if (!input.meta && !input.control) return null
  const code = input.code ?? ''
  if (code === 'Equal' || code === 'NumpadAdd' || input.key === '=' || input.key === '+')
    return 'in'
  if (code === 'Minus' || code === 'NumpadSubtract' || input.key === '-' || input.key === '_') {
    return 'out'
  }
  if (code === 'Digit0' || code === 'Numpad0' || input.key === '0') return 'reset'
  return null
}

export function nextZoomLevel(current: number, intent: ZoomIntent): number {
  if (intent === 'reset') return 0
  const next = current + (intent === 'in' ? ZOOM_STEP : -ZOOM_STEP)
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
}

export interface ZoomLevelStore {
  read(): number
  write(level: number): void
}

/**
 * Zoom the page like a browser does, and keep the level across launches. The saved level is applied
 * on every load, so a reload or a relaunch comes back at the size you chose.
 */
export function installWindowZoom(window: BrowserWindow, store: ZoomLevelStore): void {
  window.webContents.on('did-finish-load', () => {
    window.webContents.setZoomLevel(store.read())
  })
  window.webContents.on('before-input-event', (event, input) => {
    const intent = zoomIntentForInput(input)
    if (!intent) return
    event.preventDefault()
    const level = nextZoomLevel(window.webContents.getZoomLevel(), intent)
    window.webContents.setZoomLevel(level)
    store.write(level)
  })
}
