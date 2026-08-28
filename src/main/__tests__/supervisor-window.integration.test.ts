/**
 * The real Computer Use supervisor window configured against an Electron window boundary.
 * This proves the product window can resize without weakening its always-on-top behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  shown: 0,
  hidden: 0,
  handlers: new Map<string, () => unknown>()
}))

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/offgrid-supervisor-test'
  },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })
  },
  ipcMain: {
    handle: (channel: string, handler: () => unknown) => electron.handlers.set(channel, handler)
  },
  BrowserWindow: class BrowserWindow {
    private visible = false

    constructor(options: Record<string, unknown>) {
      electron.options.push(options)
    }

    isDestroyed(): boolean {
      return false
    }

    isVisible(): boolean {
      return this.visible
    }

    showInactive(): void {
      this.visible = true
      electron.shown += 1
    }

    setVisibleOnAllWorkspaces(): void {}
    setAlwaysOnTop(): void {}
    on(): void {}
    loadURL(): Promise<void> {
      return Promise.resolve()
    }
    loadFile(): Promise<void> {
      return Promise.resolve()
    }
    hide(): void {
      this.visible = false
      electron.hidden += 1
    }
  }
}))

describe('Computer Use supervisor window', () => {
  beforeEach(() => {
    vi.resetModules()
    electron.options.length = 0
    electron.shown = 0
    electron.hidden = 0
    electron.handlers.clear()
  })

  it('opens as a user-resizable PiP with a bounded readable minimum size', async () => {
    const { showSupervisorWindow } = await import('../vision/supervisor-window')

    showSupervisorWindow()

    expect(electron.options).toHaveLength(1)
    expect(electron.options[0]).toMatchObject({
      width: 520,
      height: 680,
      minWidth: 360,
      minHeight: 480,
      resizable: true,
      frame: false,
      alwaysOnTop: true
    })
    expect(electron.shown).toBe(1)
  })

  it('dismisses and reopens the same PiP without issuing a task command', async () => {
    const { registerSupervisorWindowIpc, showSupervisorWindow } =
      await import('../vision/supervisor-window')
    registerSupervisorWindowIpc()
    showSupervisorWindow()

    expect(electron.handlers.get('vision:supervisor:dismiss')?.()).toBe(true)
    expect(electron.hidden).toBe(1)
    expect(electron.handlers.get('vision:supervisor:show')?.()).toBe(true)
    expect(electron.options).toHaveLength(1)
    expect(electron.shown).toBe(2)
  })
})
