/**
 * The browser IPC contract: takeover parks broadcast to the pane, resolve-
 * takeover fails closed on junk and otherwise resolves the coordinator, and a
 * cleared park tells the pane to hide it. Electron is the mocked boundary; the
 * coordinator runs real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const world = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  sent: [] as Array<{ channel: string; payload: unknown }>
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      world.handlers.set(channel, handler)
    }
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: unknown) => world.sent.push({ channel, payload })
        }
      }
    ]
  }
}))

import { parseTakeoverOutcome, registerBrowserIpc } from '../browser-ipc'
import { getTakeoverCoordinator } from '../takeover'

describe('parseTakeoverOutcome', () => {
  it('accepts the two known verdicts and refuses everything else', () => {
    expect(parseTakeoverOutcome('resumed')).toBe('resumed')
    expect(parseTakeoverOutcome('cancelled')).toBe('cancelled')
    for (const junk of ['approve', '', null, 42, {}]) {
      expect(parseTakeoverOutcome(junk)).toBeNull()
    }
  })
})

describe('registerBrowserIpc', () => {
  beforeEach(() => {
    world.handlers.clear()
    world.sent.length = 0
    registerBrowserIpc()
  })

  it('a parked takeover broadcasts to the pane, and resolve-takeover resolves it', async () => {
    const parked = getTakeoverCoordinator().waitForTakeover('task_1', 'sign in to continue')
    expect(world.sent).toContainEqual({
      channel: 'browser:takeover',
      payload: { taskId: 'task_1', why: 'sign in to continue' }
    })

    const handler = world.handlers.get('browser:resolve-takeover')
    expect(await handler?.({}, 'task_1', 'resumed')).toBe(true)
    await expect(parked).resolves.toBe('resumed')
    // Clearing the park tells the pane to hide its prompt.
    expect(world.sent).toContainEqual({
      channel: 'browser:takeover-cleared',
      payload: { taskId: 'task_1' }
    })
  })

  it('resolve-takeover fails closed on a bad outcome or non-string id', async () => {
    const handler = world.handlers.get('browser:resolve-takeover')
    expect(await handler?.({}, 'task_x', 'sudo')).toBe(false)
    expect(await handler?.({}, 42, 'resumed')).toBe(false)
    expect(await handler?.({}, 'ghost', 'resumed')).toBe(false)
  })
})
