/**
 * The supervisor bridge: a renderer Stop/Pause/Resume reaches the active task's
 * guard, commands fail closed, a stale command after the task ends is refused,
 * and step/state broadcasts reach the overlay. Electron is the mocked boundary;
 * the guard runs real.
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

import {
  emitVisionState,
  emitVisionStep,
  parseVisionCommand,
  registerVisionIpc,
  registerVisionSession
} from '../vision-controller'
import { VisionGuard } from '../vision-guard'

describe('parseVisionCommand', () => {
  it('accepts the three commands and refuses everything else', () => {
    expect(parseVisionCommand('stop')).toBe('stop')
    expect(parseVisionCommand('pause')).toBe('pause')
    expect(parseVisionCommand('resume')).toBe('resume')
    for (const junk of ['halt', '', null, 3, {}]) {
      expect(parseVisionCommand(junk)).toBeNull()
    }
  })
})

describe('registerVisionIpc', () => {
  beforeEach(() => {
    world.handlers.clear()
    world.sent.length = 0
    registerVisionIpc()
  })

  it('Stop halts the active task guard', async () => {
    const guard = new VisionGuard()
    const dispose = registerVisionSession(guard)
    const handler = world.handlers.get('vision:control')
    expect(await handler?.({}, 'stop')).toBe(true)
    expect(guard.isHalted).toBe(true)
    expect(guard.canActuate()).toBe(false)
    dispose()
  })

  it('Pause then Resume moves the guard through paused and back to running', async () => {
    const guard = new VisionGuard()
    registerVisionSession(guard)
    const handler = world.handlers.get('vision:control')
    await handler?.({}, 'pause')
    expect(guard.isPaused).toBe(true)
    await handler?.({}, 'resume')
    expect(guard.canActuate()).toBe(true)
  })

  it('a junk command is refused, not applied', async () => {
    const guard = new VisionGuard()
    registerVisionSession(guard)
    const handler = world.handlers.get('vision:control')
    expect(await handler?.({}, 'sudo')).toBe(false)
    expect(guard.canActuate()).toBe(true)
  })

  it('a stale command after the task ends reaches no guard', async () => {
    const guard = new VisionGuard()
    const dispose = registerVisionSession(guard)
    dispose()
    const handler = world.handlers.get('vision:control')
    expect(await handler?.({}, 'stop')).toBe(false)
    expect(guard.isHalted).toBe(false)
  })
})

describe('the overlay feed', () => {
  beforeEach(() => {
    world.sent.length = 0
  })

  it('broadcasts step lines and lifecycle state to the overlay', () => {
    emitVisionStep('t1', 'clicked at (500, 400)')
    emitVisionState({ taskId: 't1', goal: 'share the deck', status: 'running' })
    expect(world.sent).toContainEqual({
      channel: 'vision:step',
      payload: { taskId: 't1', note: 'clicked at (500, 400)' }
    })
    expect(world.sent).toContainEqual({
      channel: 'vision:task-state',
      payload: { taskId: 't1', goal: 'share the deck', status: 'running' }
    })
  })
})
