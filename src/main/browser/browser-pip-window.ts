import { BrowserWindow, screen } from 'electron'
import { PRODUCT_NAME } from '../../shared/product-identity'

/**
 * The floating window that keeps a running Web Use task visible after the user navigates away.
 *
 * It hosts the SAME native WebContentsView the docked pane uses — it is not a copy, a screenshot
 * stream, or a second page. The view has one host at a time and this window is simply the other
 * possible answer, which is why nothing here knows about tasks, sessions or CDP: it owns a
 * rectangle and nothing else.
 *
 * Deliberately chrome-less content: no preload, no renderer route, no HTML. The whole client area
 * is the guest view, so anything loaded here would only fight it for space.
 */

const MARGIN = 24
const DEFAULT_WIDTH = 480
const DEFAULT_HEIGHT = 320
const MIN_WIDTH = 280
const MIN_HEIGHT = 200

let pip: BrowserWindow | null = null
/** Survives close/reopen within a session so the window returns where the user put it. */
let lastBounds: { x: number; y: number; width: number; height: number } | null = null

function defaultPosition(): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: area.x + area.width - DEFAULT_WIDTH - MARGIN,
    y: area.y + area.height - DEFAULT_HEIGHT - MARGIN
  }
}

function create(): BrowserWindow {
  const position = lastBounds ?? {
    ...defaultPosition(),
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT
  }
  const win = new BrowserWindow({
    width: position.width,
    height: position.height,
    x: position.x,
    y: position.y,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    frame: false,
    // Resizable and movable, unlike the Computer Use supervisor: this one shows a live web page the
    // user reads, so they need to be able to make it bigger.
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // A macOS NSPanel floats over another app's full-screen Space without demoting this app to
    // accessory - the same reason the Computer Use supervisor and the clipboard popup use it.
    type: process.platform === 'darwin' ? 'panel' : undefined,
    alwaysOnTop: true,
    title: `${PRODUCT_NAME} - Web Use`,
    backgroundColor: '#0A0A0A'
  })
  pip = win
  // Plain alwaysOnTop is not enough to sit above a full-screen app on macOS.
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  const remember = (): void => {
    if (!win.isDestroyed()) lastBounds = win.getBounds()
  }
  win.on('resize', remember)
  win.on('move', remember)
  win.on('closed', () => {
    if (pip === win) pip = null
  })
  return win
}

/**
 * Show the floating window, creating it if needed, WITHOUT stealing focus. Idempotent.
 *
 * `onResize` is invoked whenever the user resizes it, because a hosted native view does not follow
 * its window — its bounds are set explicitly, so somebody has to re-apply them.
 */
export function showBrowserPipWindow(onResize?: () => void): BrowserWindow {
  const existing = pip && !pip.isDestroyed() ? pip : null
  const win = existing ?? create()
  if (!existing && onResize) win.on('resize', onResize)
  if (!win.isVisible()) win.showInactive()
  return win
}

/** Hide and release the window. The guest view must be re-hosted BEFORE calling this, or it is
 *  destroyed along with its parent. */
export function closeBrowserPipWindow(): void {
  const win = pip
  pip = null
  if (!win || win.isDestroyed()) return
  try {
    win.close()
  } catch {
    // Already going away; nothing to release.
  }
}

export function browserPipWindow(): BrowserWindow | null {
  return pip && !pip.isDestroyed() ? pip : null
}

/** The client rectangle a hosted view should fill, in view-local coordinates. */
export function browserPipContentBounds(win: BrowserWindow): {
  x: number
  y: number
  width: number
  height: number
} {
  const { width, height } = win.getContentBounds()
  return { x: 0, y: 0, width, height }
}
