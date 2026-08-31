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
import { applyRemoteTaskControl } from '../../tasks/remote-task-control'

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
    const guard = new VisionGuard({ taskId: 'stop-task', kind: 'computer_use' })
    const request = new AbortController()
    const dispose = owner.registerSession('stop-task', guard, request)
    const handler = world.handlers.get('vision:control')
    expect(await handler?.({}, 'stop', 'stop-task')).toBe(true)
    expect(guard.isHalted).toBe(true)
    expect(guard.canActuate()).toBe(false)
    expect(request.signal.aborted).toBe(true)
    dispose()
  })

  it('projects Web Use controls from the shared owner without creating Computer Use state', () => {
    const guard = new VisionGuard({ taskId: 'web-control-task', kind: 'web_use' })
    const request = new AbortController()
    const projected: Array<{ status: string; action: string; kind: string }> = []
    owner.registerSession('web-control-task', guard, request, (snapshot, status, action) => {
      projected.push({ status, action, kind: snapshot.kind })
    })

    expect(owner.control('pause', 'web-control-task')).toBe(true)
    expect(owner.control('resume', 'web-control-task')).toBe(true)
    expect(owner.control('stop', 'web-control-task')).toBe(true)

    expect(projected).toEqual([
      { status: 'paused', action: 'Paused by you', kind: 'web_use' },
      { status: 'running', action: 'Reading the current screen', kind: 'web_use' },
      { status: 'stopped', action: 'Stopped from the supervisor', kind: 'web_use' }
    ])
    expect(records).toEqual([])
    expect(request.signal.aborted).toBe(true)
  })

  it('sends a remote Web Use Stop through the same shared task owner', () => {
    const guard = new VisionGuard({ taskId: 'remote-web-task', kind: 'web_use' })
    const request = new AbortController()
    const projected: string[] = []
    owner.registerSession('remote-web-task', guard, request, (_snapshot, status) => {
      projected.push(status)
    })

    expect(
      applyRemoteTaskControl('remote-web-task', 'web_use', 'stop', {
        controlVisionTask: (command, taskId) => owner.control(command, taskId)
      })
    ).toBe(true)

    expect(projected).toEqual(['stopped'])
    expect(request.signal.aborted).toBe(true)
    expect(guard.snapshot().status).toBe('stopped')
  })

  it('rejects a session whose guard belongs to a different task', () => {
    const guard = new VisionGuard({ taskId: 'real-task', kind: 'computer_use' })
    expect(() => owner.registerSession('other-task', guard, new AbortController())).toThrow(
      'VisionGuard task identity does not match session'
    )
  })

  it('keeps Stop terminal when late loop progress arrives', async () => {
    const guard = new VisionGuard({ taskId: 'terminal-task', kind: 'computer_use' })
    const request = new AbortController()
    owner.registerSession('terminal-task', guard, request)
    owner.emitState({ taskId: 'terminal-task', goal: 'Send a message', status: 'running' })
    const handler = world.handlers.get('vision:control')

    expect(await handler?.({}, 'stop', 'terminal-task')).toBe(true)
    owner.emitState({
      taskId: 'terminal-task',
      goal: 'Send a message',
      status: 'running',
      phase: 'checking',
      currentAction: 'late model reply did not parse'
    })

    expect(owner.current().state).toMatchObject({
      taskId: 'terminal-task',
      status: 'stopped',
      phase: 'stopped',
      currentAction: 'Stopped from the supervisor'
    })
    expect(records.at(-1)).toMatchObject({ taskId: 'terminal-task', status: 'stopped' })
  })

  it('routes Esc through the same stop owner and aborts in-flight work', () => {
    const guard = new VisionGuard({ taskId: 'escape-task', kind: 'computer_use' })
    const request = new AbortController()
    owner.registerSession('escape-task', guard, request)
    owner.emitState({ taskId: 'escape-task', goal: 'Send a message', status: 'running' })

    expect(owner.stop('escape-task', 'stopped with Esc', 'Stopped with Esc')).toBe(true)

    expect(guard.isHalted).toBe(true)
    expect(request.signal.aborted).toBe(true)
    expect(owner.current().state).toMatchObject({
      status: 'stopped',
      phase: 'stopped',
      currentAction: 'Stopped with Esc'
    })
  })

  it('Stop targets one task without halting a concurrent session', async () => {
    const firstGuard = new VisionGuard({ taskId: 'first-task', kind: 'computer_use' })
    const firstRequest = new AbortController()
    owner.registerSession('first-task', firstGuard, firstRequest)
    const secondGuard = new VisionGuard({ taskId: 'second-task', kind: 'computer_use' })
    const secondRequest = new AbortController()
    owner.registerSession('second-task', secondGuard, secondRequest)
    const handler = world.handlers.get('vision:control')

    expect(await handler?.({}, 'stop', 'first-task')).toBe(true)
    expect(firstGuard.isHalted).toBe(true)
    expect(firstRequest.signal.aborted).toBe(true)
    expect(secondGuard.canCapture).toBe(true)
    expect(secondRequest.signal.aborted).toBe(false)
  })

  it('Pause then Resume moves the guard through paused and back to running', async () => {
    const guard = new VisionGuard({ taskId: 'pause-task', kind: 'computer_use' })
    owner.registerSession('pause-task', guard, new AbortController())
    owner.emitState({ taskId: 'pause-task', goal: 'Pause this task', status: 'running' })
    const handler = world.handlers.get('vision:control')
    await handler?.({}, 'pause')
    expect(guard.isPaused).toBe(true)
    await handler?.({}, 'resume')
    expect(guard.canCapture).toBe(true)
    expect(guard.canActuate()).toBe(false)
    expect(guard.markObservationReady()).toBe(true)
  })

  it('Take Over pauses immediately and reports that the user has control', async () => {
    const guard = new VisionGuard({ taskId: 'takeover-task', kind: 'computer_use' })
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

  it('parks call_user under the task owner until Continue resumes the same task', async () => {
    const guard = new VisionGuard({ taskId: 'handoff-task', kind: 'computer_use' })
    owner.registerSession('handoff-task', guard, new AbortController())
    owner.emitState({
      taskId: 'handoff-task',
      journeyId: 'same-chat-task',
      goal: 'Finish sign in',
      status: 'running',
      phase: 'thinking'
    })

    let resumed = false
    const waiting = owner.waitForUser('handoff-task', 'Enter the one-time code').then(() => {
      resumed = true
    })
    await Promise.resolve()

    expect(resumed).toBe(false)
    expect(guard.snapshot()).toMatchObject({
      status: 'waiting_for_user',
      reason: 'Enter the one-time code'
    })
    expect(owner.current().state).toMatchObject({
      taskId: 'handoff-task',
      journeyId: 'same-chat-task',
      status: 'waiting',
      phase: 'waiting',
      currentAction: 'Enter the one-time code'
    })
    expect(records.at(-1)).toMatchObject({
      taskId: 'handoff-task',
      journeyId: 'same-chat-task',
      status: 'waiting'
    })

    owner.emitState({
      taskId: 'handoff-task',
      goal: 'Finish sign in',
      status: 'running',
      phase: 'thinking',
      currentAction: 'Late model output'
    })
    expect(owner.current().state).toMatchObject({
      status: 'waiting',
      currentAction: 'Enter the one-time code'
    })

    expect(owner.control('resume', 'handoff-task')).toBe(true)
    await waiting
    expect(resumed).toBe(true)
    expect(owner.current().state).toMatchObject({
      taskId: 'handoff-task',
      journeyId: 'same-chat-task',
      status: 'running',
      phase: 'observing',
      currentAction: 'Reading the current screen'
    })
  })

  it('Stop is terminal while call_user waits and releases the parked task', async () => {
    const guard = new VisionGuard({ taskId: 'waiting-stop-task', kind: 'computer_use' })
    const request = new AbortController()
    owner.registerSession('waiting-stop-task', guard, request)
    owner.emitState({
      taskId: 'waiting-stop-task',
      goal: 'Finish sign in',
      status: 'running'
    })
    const waiting = owner.waitForUser('waiting-stop-task', 'Enter the password')

    expect(owner.stop('waiting-stop-task', 'stopped by you', 'Stopped by you')).toBe(true)
    await waiting
    owner.emitState({
      taskId: 'waiting-stop-task',
      goal: 'Finish sign in',
      status: 'running',
      phase: 'observing'
    })

    expect(request.signal.aborted).toBe(true)
    expect(guard.isHalted).toBe(true)
    expect(owner.current().state).toMatchObject({
      taskId: 'waiting-stop-task',
      status: 'stopped',
      phase: 'stopped',
      currentAction: 'Stopped by you'
    })
  })

  it('a junk command is refused, not applied', async () => {
    const guard = new VisionGuard({ taskId: 'junk-task', kind: 'computer_use' })
    owner.registerSession('junk-task', guard, new AbortController())
    owner.emitState({ taskId: 'junk-task', goal: 'Ignore junk', status: 'running' })
    const handler = world.handlers.get('vision:control')
    expect(await handler?.({}, 'sudo')).toBe(false)
    expect(guard.canCapture).toBe(true)
  })

  it('a stale command after the task ends reaches no guard', async () => {
    const guard = new VisionGuard({ taskId: 'stale-task', kind: 'computer_use' })
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

  it('never replaces the durable execution plan with its display step cache', () => {
    owner.emitState({ taskId: 'plan-task', goal: 'Send the message', status: 'running' })
    owner.emitStep('plan-task', 'TASK_PLAN:{"version":1,"phases":[]}')
    owner.emitState({
      taskId: 'plan-task',
      goal: 'Send the message',
      status: 'running',
      phase: 'checking'
    })

    expect(owner.current().steps).toEqual(['TASK_PLAN:{"version":1,"phases":[]}'])
    expect(records.at(-1)).not.toHaveProperty('steps')
  })
})
