/**
 * The Computer Use supervisor boundary configured against an Electron window boundary.
 * The compact PiP stays visible without taking focus and remains visible in capture.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  shown: 0,
  hidden: 0,
  bounds: [] as Array<{ x: number; y: number; width: number; height: number }>,
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/offgrid-supervisor-test'
  },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler)
  },
  BrowserWindow: class BrowserWindow {
    private visible = false
    private bounds: { x: number; y: number; width: number; height: number }

    constructor(options: Record<string, unknown>) {
      electron.options.push(options)
      this.bounds = {
        x: options.x as number,
        y: options.y as number,
        width: options.width as number,
        height: options.height as number
      }
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
    getBounds(): { x: number; y: number; width: number; height: number } {
      return this.bounds
    }
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
      this.bounds = bounds
      electron.bounds.push(bounds)
    }
  }
}))

vi.mock('../computer-use-settings', () => ({
  getComputerUseSettings: () => ({ showPictureInPicture: true })
}))

describe('Computer Use supervisor window', () => {
  beforeEach(() => {
    vi.resetModules()
    electron.options.length = 0
    electron.shown = 0
    electron.hidden = 0
    electron.bounds.length = 0
    electron.handlers.clear()
  })

  it('shows a compact PiP without taking focus or enabling capture protection', async () => {
    const { showSupervisorWindow } = await import('../vision/supervisor-window')

    showSupervisorWindow()

    expect(electron.options).toHaveLength(1)
    expect(electron.options[0]).toMatchObject({ width: 360, height: 130, show: false })
    expect(electron.shown).toBe(1)
  })

  it('lets supervisor IPC show and dismiss the PiP without issuing a task command', async () => {
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

  it('expands upward from the anchored bottom edge and collapses again', async () => {
    const { registerSupervisorWindowIpc, showSupervisorWindow } =
      await import('../vision/supervisor-window')
    registerSupervisorWindowIpc()
    showSupervisorWindow()

    expect(electron.handlers.get('vision:supervisor:set-expanded')?.({}, true)).toBe(true)
    expect(electron.bounds.at(-1)).toEqual({ x: 1056, y: 396, width: 360, height: 480 })

    expect(electron.handlers.get('vision:supervisor:set-expanded')?.({}, false)).toBe(true)
    expect(electron.bounds.at(-1)).toEqual({ x: 1056, y: 746, width: 360, height: 130 })
  })
})
