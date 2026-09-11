/**
 * Main-window startup through the real Desktop composition. Electron owns the native window,
 * display, menu, and external-shell boundaries, so those are represented here; window policy,
 * persisted settings, path resolution, and main-window ownership stay production-real.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-main-window-'))
const originalUserData = process.env.OFFGRID_USER_DATA
process.env.OFFGRID_USER_DATA = profile

interface WindowBoundary {
  options: Record<string, unknown>
  trace: string[]
  shown: boolean
  destroyed: boolean
  listeners: Map<string, () => void>
  openHandler: (details: { url: string }) => { action: string }
  webContents: {
    listeners: Map<string, Array<(...args: unknown[]) => void>>
    visualZoomLimits: [number, number] | null
    zoomLevel: number
    setVisualZoomLevelLimits(minimum: number, maximum: number): void
    setWindowOpenHandler(handler: WindowBoundary['openHandler']): void
    setZoomLevel(level: number): void
    getZoomLevel(): number
    on(event: string, listener: (...args: unknown[]) => void): void
  }
  maximize(): void
  show(): void
  on(event: string, listener: () => void): void
  loadFile(file: string): void
  loadURL(url: string): void
  isDestroyed(): boolean
}

const electronBoundary = vi.hoisted(() => ({
  windows: [] as WindowBoundary[],
  externalUrls: [] as string[],
  menuTemplate: [] as unknown[]
}))

vi.mock('electron', () => {
  const BrowserWindow = Object.assign(
    function TestBrowserWindow(options: Record<string, unknown>): WindowBoundary {
      const listeners = new Map<string, () => void>()
      const trace: string[] = []
      const webContents = {
        listeners: new Map<string, Array<(...args: unknown[]) => void>>(),
        visualZoomLimits: null as [number, number] | null,
        zoomLevel: 0,
        setVisualZoomLevelLimits(minimum: number, maximum: number) {
          webContents.visualZoomLimits = [minimum, maximum]
        },
        setWindowOpenHandler(handler: WindowBoundary['openHandler']) {
          window.openHandler = handler
        },
        setZoomLevel(level: number) {
          webContents.zoomLevel = level
        },
        getZoomLevel() {
          return webContents.zoomLevel
        },
        on(event: string, listener: (...args: unknown[]) => void) {
          const listeners = webContents.listeners.get(event) ?? []
          listeners.push(listener)
          webContents.listeners.set(event, listeners)
        }
      }
      const window: WindowBoundary = {
        options,
        trace,
        shown: false,
        destroyed: false,
        listeners,
        openHandler: () => ({ action: 'allow' }),
        webContents,
        maximize() {
          trace.push('maximize')
        },
        show() {
          window.shown = true
          trace.push('show')
        },
        on(event, listener) {
          listeners.set(event, listener)
        },
        loadFile(file) {
          trace.push(`loadFile:${file}`)
        },
        loadURL(url) {
          trace.push(`loadURL:${url}`)
        },
        isDestroyed() {
          return window.destroyed
        }
      }
      electronBoundary.windows.push(window)
      return window
    },
    { getFocusedWindow: () => undefined }
  )

  return {
    app: {
      getAppPath: () => process.cwd(),
      getPath: () => process.env.OFFGRID_USER_DATA
    },
    BrowserWindow,
    Menu: {
      buildFromTemplate: (template: unknown[]) => {
        electronBoundary.menuTemplate = template
        return { template }
      },
      setApplicationMenu: () => undefined
    },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString()
    },
    screen: {
      getPrimaryDisplay: () => ({ workAreaSize: { width: 1512, height: 944 } })
    },
    shell: {
      openExternal: (url: string) => {
        electronBoundary.externalUrls.push(url)
      }
    }
  }
})

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

let closeDatabase: (() => void) | undefined

afterAll(() => {
  for (const window of electronBoundary.windows) window.destroyed = true
  closeDatabase?.()
  if (originalUserData === undefined) delete process.env.OFFGRID_USER_DATA
  else process.env.OFFGRID_USER_DATA = originalUserData
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('main-window startup integration', () => {
  it('opens the real renderer at the display work area and keeps zoom and links under Desktop policy', async () => {
    vi.resetModules()
    const [{ createMainWindow }, { getDB, getSetting }, { getMainWindow }, windowZoom] =
      await Promise.all([
        import('../src/main/create-main-window'),
        import('../src/main/database'),
        import('../src/main/main-window'),
        import('../src/main/window-zoom')
      ])
    closeDatabase = () => {
      if (getDB().open) getDB().close()
    }
    createMainWindow(true)

    const window = electronBoundary.windows[0]
    expect(window).toBeDefined()
    expect(window?.options).toMatchObject({
      width: 1512,
      height: 944,
      minWidth: 900,
      minHeight: 670,
      show: false,
      title: 'Off Grid AI Desktop',
      webPreferences: {
        sandbox: false,
        contextIsolation: true,
        plugins: true
      }
    })
    expect(getMainWindow()).toBe(window)
    expect(window?.shown).toBe(false)
    expect(window?.trace).toEqual([
      'maximize',
      `loadFile:${path.join(process.cwd(), 'out', 'renderer', 'index.html')}`
    ])

    window?.listeners.get('ready-to-show')?.()
    expect(window?.shown).toBe(true)
    expect(window?.trace[0]).toBe('maximize')

    for (const listener of window?.webContents.listeners.get('did-finish-load') ?? []) listener()
    expect(window?.webContents.visualZoomLimits).toEqual([1, 1])
    expect(window?.webContents.zoomLevel).toBe(0)

    const preventDefault = vi.fn()
    for (const listener of window?.webContents.listeners.get('before-input-event') ?? []) {
      listener(
        { preventDefault },
        {
          type: 'keyDown',
          key: '=',
          code: 'Equal',
          meta: true,
          control: false,
          alt: false
        }
      )
    }
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(window?.webContents.zoomLevel).toBe(0.5)
    expect(getSetting(windowZoom.WINDOW_ZOOM_LEVEL_SETTING, 0)).toBe(0.5)

    const viewMenu = electronBoundary.menuTemplate.find(
      (item) => (item as { label?: string }).label === 'View'
    ) as { submenu: Array<{ label?: string; click?: () => void }> }
    viewMenu.submenu.find((item) => item.label === 'Actual Size')?.click?.()
    expect(window?.webContents.zoomLevel).toBe(0)
    expect(getSetting(windowZoom.WINDOW_ZOOM_LEVEL_SETTING, -1)).toBe(0)

    expect(window?.openHandler({ url: 'https://getoffgridai.co/docs' })).toEqual({ action: 'deny' })
    expect(electronBoundary.externalUrls).toEqual(['https://getoffgridai.co/docs'])
    expect(electronBoundary.menuTemplate).not.toHaveLength(0)
  })
})
