import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronBoundary = vi.hoisted(() => {
  const handlers = new Map<string, () => unknown>()
  const send = vi.fn()
  const removeHandler = vi.fn((channel: string) => handlers.delete(channel))
  return {
    handlers,
    send,
    removeHandler,
    ipcMain: {
      handle: vi.fn((channel: string, handler: () => unknown) => handlers.set(channel, handler)),
      removeHandler
    },
    windows: [
      { isDestroyed: () => false, webContents: { send } },
      { isDestroyed: () => true, webContents: { send: vi.fn() } }
    ]
  }
})

vi.mock('electron', () => ({
  ipcMain: electronBoundary.ipcMain,
  BrowserWindow: { getAllWindows: () => electronBoundary.windows }
}))

import { registerStartupStatusIpc } from '../startup-ipc'
import { startupProjection } from '../startup-projection'

describe('startup status IPC', () => {
  beforeEach(() => {
    electronBoundary.handlers.clear()
    electronBoundary.send.mockClear()
    electronBoundary.removeHandler.mockClear()
  })

  it('returns the current snapshot, publishes changes, and fully unregisters', () => {
    const stop = registerStartupStatusIpc()
    const read = electronBoundary.handlers.get('app:startup-status')
    expect(read?.()).toEqual(startupProjection.snapshot())

    const stage = `ipc-${crypto.randomUUID()}`
    startupProjection.stageStarted({ name: stage, required: false })
    expect(electronBoundary.send).toHaveBeenCalledWith(
      'app:startup-status-changed',
      expect.objectContaining({ running: expect.arrayContaining([stage]) })
    )

    const sent = electronBoundary.send.mock.calls.length
    stop()
    startupProjection.stageSettled({
      name: stage,
      status: 'completed',
      required: false,
      durationMs: 1
    })
    expect(electronBoundary.send).toHaveBeenCalledTimes(sent)
    expect(electronBoundary.removeHandler).toHaveBeenCalledWith('app:startup-status')
  })
})
