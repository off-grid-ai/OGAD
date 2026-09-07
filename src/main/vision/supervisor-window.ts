/**
 * The computer-use supervisor's floating window (the `#cu-supervisor` surface).
 *
 * While the rail drives another app, that app is frontmost and Off Grid AI's main
 * window is behind it - so the in-app overlay is hidden. This is a separate
 * always-on-top NSPanel that stays visible OVER whatever is being driven, the
 * same window kind the clipboard/dictation overlays use (a macOS panel is the
 * one type that floats over another app's full-screen Space without flipping
 * this app to accessory, which would break TCC).
 *
 * It appears WITHOUT stealing focus (showInactive) so the driven app keeps
 * focus for actuation, and it does NOT dismiss on blur - it must stay up for
 * the whole task. Opened when a computer_use starts, closed shortly after it
 * ends (see vision-controller). Native glue, excluded from coverage.
 */
import { BrowserWindow, ipcMain, screen } from 'electron'
import { preloadPath } from '../preload-path'
import { rendererHtmlPath } from '../renderer-path'

const WIN_WIDTH = 520
const WIN_HEIGHT = 680
const MIN_WIN_WIDTH = 360
const MIN_WIN_HEIGHT = 480
const MARGIN = 24

let supervisor: BrowserWindow | null = null
let supervisorCaptureWindowId: number | null = null
let closeTimer: NodeJS.Timeout | null = null

function captureWindowId(sourceId: string): number | null {
  const match = /^window:(\d+):/.exec(sourceId)
  const id = Number(match?.[1])
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function bottomRight(): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: area.x + area.width - WIN_WIDTH - MARGIN,
    y: area.y + area.height - WIN_HEIGHT - MARGIN
  }
}

function create(): BrowserWindow {
  const pos = bottomRight()
  const win = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    minWidth: MIN_WIN_WIDTH,
    minHeight: MIN_WIN_HEIGHT,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // A macOS NSPanel floats over another app's full-screen Space without
    // demoting this app to accessory (same reason as the clipboard popup).
    type: process.platform === 'darwin' ? 'panel' : undefined,
    alwaysOnTop: true,
    title: 'Off Grid AI Desktop - Computer Use',
    webPreferences: {
      preload: preloadPath(),
      sandbox: false, // REQUIRED for the IPC bridge (window.api.vision.*)
      contextIsolation: true,
      devTools: !!process.env['ELECTRON_RENDERER_URL']
    }
  })
  supervisor = win
  supervisorCaptureWindowId = captureWindowId(win.getMediaSourceId())
  // Windows excludes protected windows at the compositor. Newer macOS ScreenCaptureKit ignores
  // this flag, so the capture adapter also uses the exact source ID in SCContentFilter.
  win.setContentProtection(true)
  // Float above full-screen apps, on every Space; plain alwaysOnTop is not enough.
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.on('closed', () => {
    if (supervisor === win) {
      supervisor = null
      supervisorCaptureWindowId = null
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#cu-supervisor`)
  } else {
    void win.loadFile(rendererHtmlPath(), { hash: 'cu-supervisor' })
  }
  return win
}

/** Exact native window ID used by the Computer Use capture filter. */
export function getSupervisorCaptureWindowId(): number | null {
  return supervisorCaptureWindowId
}

/** Create the protected capture-exclusion window without making the PiP visible. */
export function ensureSupervisorCaptureWindowId(): number | null {
  if (!supervisor || supervisor.isDestroyed()) create()
  return supervisorCaptureWindowId
}

/** Show the supervisor window (creating it if needed) WITHOUT stealing focus
 *  from the app being driven. Idempotent. */
export function showSupervisorWindow(): void {
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
  const win = supervisor && !supervisor.isDestroyed() ? supervisor : create()
  if (!win.isVisible()) {
    // showInactive: appear on top but do NOT activate, so the driven app keeps
    // keyboard/mouse focus for actuation.
    win.showInactive()
  }
}

/** Hide the PiP without changing the task. The task controller remains the only owner of
 *  pause, stop, takeover, and completion state. */
export function dismissSupervisorWindow(): void {
  if (closeTimer) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
  if (supervisor && !supervisor.isDestroyed()) supervisor.hide()
}

/** Hide the supervisor window after a short delay, so the final state (done /
 *  failed + summary) is readable before it disappears. */
export function hideSupervisorWindow(delayMs = 4000): void {
  if (closeTimer) {
    clearTimeout(closeTimer)
  }
  closeTimer = setTimeout(() => {
    closeTimer = null
    if (supervisor && !supervisor.isDestroyed()) {
      supervisor.hide()
    }
  }, delayMs)
}

/** Renderer intent for PiP visibility only. Task controls use the separate vision controller. */
export function registerSupervisorWindowIpc(): void {
  ipcMain.handle('vision:supervisor:show', () => {
    showSupervisorWindow()
    return true
  })
  ipcMain.handle('vision:supervisor:dismiss', () => {
    dismissSupervisorWindow()
    return true
  })
}
