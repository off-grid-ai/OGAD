/**
 * The Computer Use supervisor boundary configured against an Electron window boundary.
 * The compact PiP stays visible without taking focus and remains excluded from capture.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  shown: 0,
  hidden: 0,
  protected: [] as boolean[],
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/offgrid-supervisor-test'
  },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler)
  },
  BrowserWindow: class BrowserWindow {
    private visible = false

    constructor(options: Record<string, unknown>) {
      electron.options.push(options)
    }

    getMediaSourceId(): string {
      return 'window:73:0'
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
    setContentProtection(protectedFromCapture: boolean): void {
      electron.protected.push(protectedFromCapture)
    }
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
    electron.protected.length = 0
    electron.handlers.clear()
  })

  it('shows a compact protected PiP without taking focus', async () => {
    const { showSupervisorWindow } = await import('../vision/supervisor-window')

    showSupervisorWindow()

    expect(electron.options).toHaveLength(1)
    expect(electron.options[0]).toMatchObject({ width: 360, height: 480, show: false })
    expect(electron.protected).toEqual([true])
    expect(electron.shown).toBe(1)
  })

  it('creates the protected capture exclusion without showing the PiP', async () => {
    const { ensureSupervisorCaptureWindowId } = await import('../vision/supervisor-window')

    expect(ensureSupervisorCaptureWindowId()).toBe(73)
    expect(electron.options).toHaveLength(1)
    expect(electron.protected).toEqual([true])
    expect(electron.shown).toBe(0)
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
})
