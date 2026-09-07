import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('Desktop main-window lifecycle owner', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('exposes only the live Electron main window', async () => {
    const { getMainWindow, setMainWindow } = await import('../main-window')
    let destroyed = false
    const windowBoundary = {
      isDestroyed: () => destroyed
    } as BrowserWindow

    expect(getMainWindow()).toBeNull()

    setMainWindow(windowBoundary)
    expect(getMainWindow()).toBe(windowBoundary)

    destroyed = true
    expect(getMainWindow()).toBeNull()
  })
})
