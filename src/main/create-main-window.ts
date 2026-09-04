import { BrowserWindow, screen, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { PRODUCT_NAME } from '../shared/product-identity'
import { preloadPath } from './preload-path'
import { rendererHtmlPath } from './renderer-path'
import { setMainWindow } from './main-window'
import { getSetting, saveSetting } from './database'
import { installWindowZoom, installZoomMenu, WINDOW_ZOOM_LEVEL_SETTING } from './window-zoom'

export function createMainWindow(showWindow: boolean): void {
  // Open filling the screen, because this is a desktop-first, dense app: multi-column grids, master
  // detail lists and side panels. At 900x670 the Models grid collapsed to one card per row, the chat
  // history rail ate a third of the width, and every screen looked like a phone layout stretched.
  //
  // The work area, not the display bounds - that excludes the menu bar and Dock, so the window fills
  // what the user can actually use. maximize() on top of it because the work area is only the
  // starting size; maximizing is what makes the OS treat the window as filled and keeps it that way
  // through a display change.
  //
  // Not fullscreen: on macOS that moves the app to its own Space and hides the menu bar, so a user who
  // just wanted a big window loses Mission Control and every other window alongside it.
  const { workAreaSize } = screen.getPrimaryDisplay()
  const mainWindow = new BrowserWindow({
    width: workAreaSize.width,
    height: workAreaSize.height,
    // The old default is now the floor: below this the dense layouts stop working.
    minWidth: 900,
    minHeight: 670,
    show: false,
    title: PRODUCT_NAME,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' || process.platform === 'win32' ? { icon } : {}),
    webPreferences: {
      preload: preloadPath(),
      sandbox: false, // REQUIRED for IPC
      contextIsolation: true,
      plugins: true, // Chromium's built-in PDF viewer (chat attachment viewer) needs this
      devTools: is.dev // no inspector in the packaged/production build (tamper-proofing)
    }
  })
  // Cmd/Ctrl + and - zoom the page; the app has no menu bar to carry the standard roles. The
  // level persists with the other settings.
  const zoomStore = {
    read: () => getSetting<number>(WINDOW_ZOOM_LEVEL_SETTING, 0),
    write: (level: number) => saveSetting(WINDOW_ZOOM_LEVEL_SETTING, level)
  }
  installWindowZoom(mainWindow, zoomStore)
  installZoomMenu(() => BrowserWindow.getFocusedWindow() ?? mainWindow, zoomStore)

  // Record THE main window so callers that lay a view over it (the browser
  // rail) attach to the right window, not a stray overlay from getAllWindows().
  setMainWindow(mainWindow)

  // Maximized before the first paint, not on ready-to-show: the window is still hidden here, so it
  // opens at full size instead of appearing at the constructed size and jumping. It also means anything
  // that reads the window as soon as it exists sees the real geometry - on ready-to-show the renderer
  // can already have loaded, so the size depended on which happened first.
  mainWindow.maximize()

  // Nothing is shown in a headless (e2e) run - see window-presentation for why the suite needs that on
  // macOS, where Playwright cannot make an Electron app headless and there is no xvfb to hide it behind.
  // The renderer has already loaded and painted by now either way, which is all Playwright drives.
  mainWindow.on('ready-to-show', () => {
    if (showWindow) mainWindow.show()
  })

  // Pinch-zoom stays off; the keyboard zoom above owns the level and restores it on load.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.setVisualZoomLevelLimits(1, 1)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(rendererHtmlPath())
  }
}
