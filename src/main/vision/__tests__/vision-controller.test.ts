/**
 * The supervisor bridge: a renderer Stop/Pause/Take Over/Resume reaches the active task's
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
  parseVisionCommand,
  registerVisionIpc,
  VisionController,
  type VisionControllerPersistence
} from '../vision-controller'
import { VisionGuard } from '../vision-guard'

let owner: VisionController
let records: Parameters<VisionControllerPersistence['record']>[0][]

beforeEach(() => {
  records = []
  owner = new VisionController({
    appendStep: () => undefined,
    record: (update) => records.push(update),
    executionDevice: () => ({ id: 'studio-mac', name: 'Studio Mac' })
  })
})

describe('parseVisionCommand', () => {
  it('accepts the four explicit commands and refuses everything else', () => {
    expect(parseVisionCommand('stop')).toBe('stop')
    expect(parseVisionCommand('pause')).toBe('pause')
    expect(parseVisionCommand('takeover')).toBe('takeover')
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
    registerVisionIpc(owner)
  })

  it('Stop halts the active task guard', async () => {
    const guard = new VisionGuard()
    const request = new AbortController()
    const dispose = owner.registerSession('stop-task', guard, request)
    const handler = world.handlers.get('vision:control')
    expect(await handler?.({}, 'stop', 'stop-task')).toBe(true)
    expect(guard.isHalted).toBe(true)
    expect(guard.canActuate()).toBe(false)
    expect(request.signal.aborted).toBe(true)
    dispose()
  })

  it('Stop targets one task without halting a concurrent session', async () => {
    const firstGuard = new VisionGuard()
    const firstRequest = new AbortController()
    owner.registerSession('first-task', firstGuard, firstRequest)
    const secondGuard = new VisionGuard()
    const secondRequest = new AbortController()
    owner.registerSession('second-task', secondGuard, secondRequest)
    const handler = world.handlers.get('vision:control')

    expect(await handler?.({}, 'stop', 'first-task')).toBe(true)
    expect(firstGuard.isHalted).toBe(true)
    expect(firstRequest.signal.aborted).toBe(true)
    expect(secondGuard.canActuate()).toBe(true)
    expect(secondRequest.signal.aborted).toBe(false)
  })

  it('Pause then Resume moves the guard through paused and back to running', async () => {
    const guard = new VisionGuard()
    owner.registerSession('pause-task', guard, new AbortController())
    owner.emitState({ taskId: 'pause-task', goal: 'Pause this task', status: 'running' })
    const handler = world.handlers.get('vision:control')
    await handler?.({}, 'pause')
    expect(guard.isPaused).toBe(true)
    await handler?.({}, 'resume')
    expect(guard.canActuate()).toBe(true)
  })

  it('Take Over pauses immediately and reports that the user has control', async () => {
    const guard = new VisionGuard()
    owner.registerSession('takeover-task', guard, new AbortController())
    owner.emitState({
      taskId: 'takeover-task',
      goal: 'Update the deck',
      status: 'running',
      phase: 'acting'
    })
    const handler = world.handlers.get('vision:control')

    expect(await handler?.({}, 'takeover')).toBe(true)
    expect(guard.isPaused).toBe(true)
    expect(records.at(-1)).toMatchObject({
      taskId: 'takeover-task',
      journeyId: 'takeover-task',
      executionDeviceId: 'studio-mac',
      executionDeviceName: 'Studio Mac',
      status: 'paused',
      phase: 'paused'
    })
    expect(world.sent).toContainEqual({
      channel: 'vision:task-state',
      payload: expect.objectContaining({
        taskId: 'takeover-task',
        status: 'paused',
        phase: 'paused',
        currentAction: 'You have control of this computer'
      })
    })
  })

  it('a junk command is refused, not applied', async () => {
    const guard = new VisionGuard()
    owner.registerSession('junk-task', guard, new AbortController())
    owner.emitState({ taskId: 'junk-task', goal: 'Ignore junk', status: 'running' })
    const handler = world.handlers.get('vision:control')
    expect(await handler?.({}, 'sudo')).toBe(false)
    expect(guard.canActuate()).toBe(true)
  })

  it('a stale command after the task ends reaches no guard', async () => {
    const guard = new VisionGuard()
    const dispose = owner.registerSession('stale-task', guard, new AbortController())
    dispose()
    const handler = world.handlers.get('vision:control')
    expect(await handler?.({}, 'stop', 'stale-task')).toBe(false)
    expect(guard.isHalted).toBe(false)
  })
})

describe('the overlay feed', () => {
  beforeEach(() => {
    world.sent.length = 0
  })

  it('broadcasts step lines and lifecycle state to the overlay', () => {
    owner.emitStep('t1', 'clicked at (500, 400)')
    owner.emitState({ taskId: 't1', goal: 'share the deck', status: 'running' })
    expect(world.sent).toContainEqual({
      channel: 'vision:step',
      payload: { taskId: 't1', note: 'clicked at (500, 400)' }
    })
    expect(world.sent).toContainEqual({
      channel: 'vision:task-state',
      payload: expect.objectContaining({
        taskId: 't1',
        journeyId: 't1',
        goal: 'share the deck',
        status: 'running'
      })
    })
  })
})
