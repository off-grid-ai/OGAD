import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, Input, MenuItemConstructorOptions, WebContents } from 'electron'

const menuBoundary = vi.hoisted(() => ({
  template: null as MenuItemConstructorOptions[] | null,
  installed: false
}))

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate(template: MenuItemConstructorOptions[]) {
      menuBoundary.template = template
      return { template }
    },
    setApplicationMenu() {
      menuBoundary.installed = true
    }
  }
}))

import { installWindowZoom, installZoomMenu, type ZoomLevelStore } from '../window-zoom'

type InputListener = (
  event: { preventDefault(): void },
  input: Pick<Input, 'type' | 'key' | 'meta' | 'control' | 'alt'> & { code?: string }
) => void

class WindowBoundary {
  private readonly loadListeners: Array<() => void> = []
  private readonly inputListeners: InputListener[] = []
  zoomLevel = 0

  readonly webContents = {
    on: (event: string, listener: (() => void) | InputListener): void => {
      if (event === 'did-finish-load') this.loadListeners.push(listener as () => void)
      if (event === 'before-input-event') this.inputListeners.push(listener as InputListener)
    },
    setZoomLevel: (level: number): void => {
      this.zoomLevel = level
    },
    getZoomLevel: (): number => this.zoomLevel
  } as Pick<WebContents, 'on' | 'setZoomLevel' | 'getZoomLevel'>

  asBrowserWindow(): BrowserWindow {
    return { webContents: this.webContents } as BrowserWindow
  }

  finishLoad(): void {
    for (const listener of this.loadListeners) listener()
  }

  press(key: string): boolean {
    let prevented = false
    const input = {
      type: 'keyDown' as const,
      key,
      meta: true,
      control: false,
      alt: false
    }
    for (const listener of this.inputListeners) {
      listener(
        {
          preventDefault: () => {
            prevented = true
          }
        },
        input
      )
    }
    return prevented
  }
}

class PersistentZoomBoundary implements ZoomLevelStore {
  constructor(public level: number) {}

  read(): number {
    return this.level
  }

  write(level: number): void {
    this.level = level
  }
}

const menuClick = (label: string): (() => void) => {
  const view = menuBoundary.template?.find((item) => item.label === 'View')
  const items = Array.isArray(view?.submenu) ? view.submenu : []
  const item = items.find((candidate) => candidate.label === label)
  if (typeof item?.click !== 'function') throw new Error(`Menu item ${label} was not installed.`)
  return () => item.click?.({} as never, undefined, {} as never)
}

describe('Desktop window zoom lifecycle', () => {
  beforeEach(() => {
    menuBoundary.template = null
    menuBoundary.installed = false
  })

  it('restores saved zoom and persists keyboard changes', () => {
    const window = new WindowBoundary()
    const store = new PersistentZoomBoundary(1.5)
    installWindowZoom(window.asBrowserWindow(), store)

    window.finishLoad()
    expect(window.zoomLevel).toBe(1.5)

    expect(window.press('=')).toBe(true)
    expect(window.zoomLevel).toBe(2)
    expect(store.level).toBe(2)

    expect(window.press('x')).toBe(false)
    expect(window.zoomLevel).toBe(2)
    expect(store.level).toBe(2)
  })

  it('installs menu actions that use the current window and saved zoom', () => {
    const window = new WindowBoundary()
    const store = new PersistentZoomBoundary(0)
    const windowOwner: { current: BrowserWindow | undefined } = { current: undefined }
    installZoomMenu(() => windowOwner.current, store)

    expect(menuBoundary.installed).toBe(true)
    menuClick('Zoom In')()
    expect(store.level).toBe(0)

    windowOwner.current = window.asBrowserWindow()
    menuClick('Zoom In')()
    expect(window.zoomLevel).toBe(0.5)
    expect(store.level).toBe(0.5)

    menuClick('Actual Size')()
    expect(window.zoomLevel).toBe(0)
    expect(store.level).toBe(0)
  })
})
