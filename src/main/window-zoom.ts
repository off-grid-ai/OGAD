import type { BrowserWindow, Input } from 'electron'

export type ZoomIntent = 'in' | 'out' | 'reset'

const ZOOM_STEP = 0.5
const ZOOM_MIN = -3
const ZOOM_MAX = 5

/** Cmd/Ctrl with =, +, - or 0. The app draws no menu bar, so the roles that carry these are absent. */
export function zoomIntentForInput(
  input: Pick<Input, 'type' | 'key' | 'meta' | 'control' | 'alt'>
): ZoomIntent | null {
  if (input.type !== 'keyDown' || input.alt) return null
  if (!input.meta && !input.control) return null
  if (input.key === '=' || input.key === '+') return 'in'
  if (input.key === '-' || input.key === '_') return 'out'
  if (input.key === '0') return 'reset'
  return null
}

export function nextZoomLevel(current: number, intent: ZoomIntent): number {
  if (intent === 'reset') return 0
  const next = current + (intent === 'in' ? ZOOM_STEP : -ZOOM_STEP)
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
}

/** Zoom the page like a browser does. Read the level from the page so a restored zoom carries on. */
export function installWindowZoom(window: BrowserWindow): void {
  window.webContents.on('before-input-event', (event, input) => {
    const intent = zoomIntentForInput(input)
    if (!intent) return
    event.preventDefault()
    window.webContents.setZoomLevel(nextZoomLevel(window.webContents.getZoomLevel(), intent))
  })
}
