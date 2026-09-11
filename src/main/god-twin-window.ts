import { BrowserWindow, ipcMain, screen } from 'electron'
import { preloadPath } from './preload-path'
import { rendererHtmlPath } from './renderer-path'
import { getMainWindow } from './main-window'
import { getSetting, saveSetting } from './database'

const WIDTH = 420
const HEIGHT = 620
const ASPECT_RATIO = WIDTH / HEIGHT
const MARGIN = 20
const ENABLED_SETTING = 'godTwin:enabled'
const SIZE_SETTING = 'godTwin:size'
const PREFERENCES_SETTING = 'godTwin:preferences'

let companion: BrowserWindow | null = null
let movementTimer: ReturnType<typeof setTimeout> | null = null
let displayTimer: ReturnType<typeof setInterval> | null = null
let entranceTimer: ReturnType<typeof setInterval> | null = null

type GodTwinState = 'idle' | 'walking' | 'running' | 'fighting' | 'resting'
type ResizeEdge = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'
type GodTwinPreferences = { state: GodTwinState; spinning: boolean }

const DEFAULT_PREFERENCES: GodTwinPreferences = { state: 'idle', spinning: false }

function preferences(): GodTwinPreferences {
  const saved = getSetting<Partial<GodTwinPreferences>>(PREFERENCES_SETTING, DEFAULT_PREFERENCES)
  const state = ['idle', 'walking', 'running', 'fighting', 'resting'].includes(saved.state ?? '')
    ? (saved.state as GodTwinState)
    : DEFAULT_PREFERENCES.state
  return { state, spinning: saved.spinning === true }
}

function savedSize(): { width: number; height: number } {
  const saved = getSetting<{ width?: number; height?: number }>(SIZE_SETTING, {})
  const width = Math.max(120, Math.round(saved.width ?? WIDTH))
  return { width, height: Math.round(width / ASPECT_RATIO) }
}

function position(size: { width: number; height: number }): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: area.x + area.width - size.width - MARGIN,
    y: area.y + area.height - size.height - MARGIN
  }
}

function keepControlsOnScreen(win: BrowserWindow): void {
  const bounds = win.getBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  const x = Math.min(Math.max(bounds.x, area.x), area.x + Math.max(0, area.width - bounds.width))
  const y = Math.min(Math.max(bounds.y, area.y), area.y + Math.max(0, area.height - bounds.height))
  if (x !== bounds.x || y !== bounds.y) win.setPosition(x, y, false)
}

function create(): BrowserWindow {
  console.log('[god-twin] creating companion window')
  const size = savedSize()
  const win = new BrowserWindow({
    ...position(size),
    ...size,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    movable: true,
    minWidth: 120,
    minHeight: 180,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    type: process.platform === 'darwin' ? 'panel' : undefined,
    alwaysOnTop: true,
    title: 'Off Grid AI Desktop - Ares',
    webPreferences: {
      preload: preloadPath(),
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false,
      devTools: !!process.env['ELECTRON_RENDERER_URL']
    }
  })
  companion = win
  let activeDisplay = screen.getDisplayMatching(win.getBounds())

  const enterDisplay = (nextDisplay: Electron.Display): void => {
    if (entranceTimer) clearInterval(entranceTimer)
    const bounds = win.getBounds()
    const sourceArea = activeDisplay.workArea
    const targetArea = nextDisplay.workArea
    const sourceWidth = Math.max(1, sourceArea.width - bounds.width)
    const sourceHeight = Math.max(1, sourceArea.height - bounds.height)
    const relativeX = Math.min(1, Math.max(0, (bounds.x - sourceArea.x) / sourceWidth))
    const relativeY = Math.min(1, Math.max(0, (bounds.y - sourceArea.y) / sourceHeight))
    const targetX = Math.round(
      targetArea.x + relativeX * Math.max(0, targetArea.width - bounds.width)
    )
    const targetY = Math.round(
      targetArea.y + relativeY * Math.max(0, targetArea.height - bounds.height)
    )
    const startX = targetArea.x < sourceArea.x
      ? targetArea.x + targetArea.width
      : targetArea.x - bounds.width
    const startedAt = Date.now()
    const duration = 650

    activeDisplay = nextDisplay
    win.webContents.send('god-twin:state', 'running')
    win.setPosition(startX, targetY, false)
    entranceTimer = setInterval(() => {
      if (win.isDestroyed()) return
      const progress = Math.min(1, (Date.now() - startedAt) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      win.setPosition(Math.round(startX + (targetX - startX) * eased), targetY, false)
      if (progress < 1) return
      if (entranceTimer) clearInterval(entranceTimer)
      entranceTimer = null
      win.webContents.send('god-twin:state', preferences().state)
    }, 16)
  }

  displayTimer = setInterval(() => {
    if (win.isDestroyed() || !win.isVisible()) return
    const nextDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    if (nextDisplay.id !== activeDisplay.id) enterDisplay(nextDisplay)
  }, 250)
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setAspectRatio(ASPECT_RATIO)
  win.on('closed', () => {
    if (displayTimer) clearInterval(displayTimer)
    if (entranceTimer) clearInterval(entranceTimer)
    displayTimer = null
    entranceTimer = null
    if (companion === win) companion = null
  })
  win.on('move', () => {
    win.webContents.send('god-twin:state', 'running')
    if (movementTimer) clearTimeout(movementTimer)
    movementTimer = setTimeout(() => {
      if (!win.isDestroyed()) {
        keepControlsOnScreen(win)
        win.webContents.send('god-twin:state', preferences().state)
      }
    }, 300)
  })
  win.on('resize', () => {
    const { width, height } = win.getBounds()
    saveSetting(SIZE_SETTING, { width, height })
  })
  win.on('ready-to-show', () => win.showInactive())
  win.webContents.on('did-finish-load', () => console.log('[god-twin] companion renderer loaded'))
  win.webContents.on('did-fail-load', (_event, code, description) =>
    console.error('[god-twin] companion renderer failed', { code, description })
  )
  win.webContents.on('console-message', (_event, _level, message) => {
    if (message.includes('[god-twin]')) console.log(message)
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#god-twin`)
  } else {
    void win.loadFile(rendererHtmlPath(), { hash: 'god-twin' })
  }
  return win
}

export function showGodTwinWindow(): void {
  const enabled = getSetting(ENABLED_SETTING, true)
  console.log('[god-twin] show requested', { enabled })
  if (!enabled) return
  const win = companion && !companion.isDestroyed() ? companion : create()
  if (!win.isVisible()) win.showInactive()
}

export function registerGodTwinWindowIpc(): void {
  ipcMain.handle('god-twin:enabled:get', () => getSetting(ENABLED_SETTING, true))
  ipcMain.handle('god-twin:enabled:set', (_event, enabled: boolean) => {
    const next = enabled === true
    saveSetting(ENABLED_SETTING, next)
    if (next) showGodTwinWindow()
    else companion?.hide()
    return next
  })
  ipcMain.handle('god-twin:preferences:get', () => preferences())
  ipcMain.handle(
    'god-twin:preferences:set',
    (_event, patch: Partial<GodTwinPreferences>) => {
      const current = preferences()
      const next: GodTwinPreferences = {
        state: ['idle', 'walking', 'running', 'fighting', 'resting'].includes(patch.state ?? '')
          ? (patch.state as GodTwinState)
          : current.state,
        spinning: patch.spinning === undefined ? current.spinning : patch.spinning === true
      }
      saveSetting(PREFERENCES_SETTING, next)
      return next
    }
  )
  ipcMain.handle('god-twin:wake', () => {
    const mainWindow = getMainWindow()
    if (!mainWindow) return false
    mainWindow.webContents.send('god-twin:wake')
    return true
  })
  ipcMain.on('god-twin:listening', (_event, listening: boolean) => {
    companion?.webContents.send('god-twin:listening', listening === true)
  })
  ipcMain.on('god-twin:state', (_event, state: GodTwinState) => {
    if (!['idle', 'walking', 'running', 'fighting', 'resting'].includes(state)) return
    companion?.webContents.send('god-twin:state', state)
  })
  ipcMain.on(
    'god-twin:resize',
    (_event, input: { edge?: ResizeEdge; deltaX?: number; deltaY?: number }) => {
      const win = companion
      const edge = input.edge
      const deltaX = Math.round(input.deltaX ?? 0)
      const deltaY = Math.round(input.deltaY ?? 0)
      if (!win || !edge || !Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return

      const bounds = win.getBounds()
      if (!['ne', 'se', 'sw', 'nw'].includes(edge)) return
      const [, minimumHeight = 180] = win.getMinimumSize()
      const right = bounds.x + bounds.width
      const bottom = bounds.y + bounds.height
      const horizontalDelta = edge.includes('e') ? deltaX : -deltaX
      const verticalDelta = (edge.includes('s') ? deltaY : -deltaY) * ASPECT_RATIO
      const widthDelta = Math.abs(horizontalDelta) >= Math.abs(verticalDelta)
        ? horizontalDelta
        : verticalDelta
      bounds.width = Math.max(Math.ceil(minimumHeight * ASPECT_RATIO), bounds.width + widthDelta)
      bounds.height = Math.round(bounds.width / ASPECT_RATIO)
      if (edge.includes('w')) bounds.x = right - bounds.width
      if (edge.includes('n')) bounds.y = bottom - bounds.height
      win.setBounds(bounds)
    }
  )
}
