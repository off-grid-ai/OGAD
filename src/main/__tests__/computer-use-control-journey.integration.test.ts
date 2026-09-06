/**
 * Computer Use control journey: the renderer-facing preload bridge sends Stop
 * through Electron IPC to the controller that owns the live guard. The model
 * runtime is the only external boundary faked here; all Off Grid control and
 * action-loop code is production code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  invocations: [] as Array<{ channel: string; args: unknown[] }>,
  sent: [] as Array<{ channel: string; payload: unknown }>
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => electron.exposed.set(key, value)
  },
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) => {
      electron.invocations.push({ channel, args })
      return electron.handlers.get(channel)?.({}, ...args)
    },
    on: () => undefined,
    removeListener: () => undefined,
    removeAllListeners: () => undefined,
    send: () => undefined,
    sendSync: () => false
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      electron.handlers.set(channel, handler)
    }
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: unknown) => electron.sent.push({ channel, payload })
        }
      }
    ]
  }
}))

import { runElementTask, type ElementActuator } from '../accessibility/ax-agent'
import {
  registerVisionIpc,
  VisionController,
  type VisionControllerPersistence
} from '../vision/vision-controller'
import { VisionGuard } from '../vision/vision-guard'

type RendererBridge = {
  vision: {
    control(command: 'stop', taskId: string): Promise<boolean>
  }
}

describe('Computer Use supervisor control journey', () => {
  beforeEach(() => {
    electron.exposed.clear()
    electron.handlers.clear()
    electron.invocations.length = 0
    electron.sent.length = 0
  })

  it('keeps Stop terminal when an in-flight model reply arrives late', async () => {
    const records: Parameters<VisionControllerPersistence['record']>[0][] = []
    const owner = new VisionController({
      appendStep: () => undefined,
      record: (update) => records.push(update),
      executionDevice: () => ({ id: 'studio-mac', name: 'Studio Mac' })
    })
    registerVisionIpc(owner)
    await import('../../preload/index')
    const bridge = electron.exposed.get('api') as RendererBridge

    const taskId = 'computer-use-stop-journey'
    const guard = new VisionGuard({ taskId, kind: 'computer_use' })
    const request = new AbortController()
    owner.registerSession(taskId, guard, request)
    owner.emitState({
      taskId,
      goal: 'Send the message in the open app',
      status: 'running',
      phase: 'thinking',
      currentAction: 'Choosing the next action'
    })

    const actions: string[] = []
    const actuator: ElementActuator = {
      click: async (element) => void actions.push(`click:${element.index}`),
      press: async (element) => void actions.push(`press:${element.index}`),
      type: async (_element, text) => void actions.push(`type:${text}`),
      keys: async (combo) => void actions.push(`keys:${combo}`)
    }
    let releaseModelReply: ((reply: string) => void) | undefined
    let markModelStarted: (() => void) | undefined
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve
    })
    const loop = runElementTask('Send the message in the open app', {
      read: async () => ({
        windowTitle: 'Messages',
        elements: [
          {
            index: 1,
            role: 'AXButton',
            name: 'Send',
            value: '',
            cx: 20,
            cy: 20,
            actionable: true,
            enabled: true
          }
        ]
      }),
      actuator,
      decide: () =>
        new Promise<string>((resolve) => {
          releaseModelReply = resolve
          markModelStarted?.()
        }),
      waitForUser: async () => undefined,
      control: guard
    })
    await modelStarted

    // This is the exact preload method called by the supervisor Stop control.
    expect(await bridge.vision.control('stop', taskId)).toBe(true)
    expect(electron.invocations).toContainEqual({
      channel: 'vision:control',
      args: ['stop', taskId]
    })
    expect(request.signal.aborted).toBe(true)

    releaseModelReply?.('{"action":"press","index":1}')
    expect(await loop).toMatchObject({
      ok: false,
      summary: 'stopped'
    })
    expect(actions).toEqual([])

    // The host can still receive stale progress after the model promise settles.
    // It must not reopen the terminal task or replace the stopped projection.
    owner.emitState({
      taskId,
      goal: 'Send the message in the open app',
      status: 'running',
      phase: 'acting',
      currentAction: 'Press Send'
    })
    expect(owner.current().state).toMatchObject({
      taskId,
      status: 'stopped',
      phase: 'stopped',
      currentAction: 'Stopped from the supervisor'
    })
    expect(records.at(-1)).toMatchObject({ taskId, status: 'stopped' })
    expect(electron.sent.at(-1)).toMatchObject({
      channel: 'vision:task-state',
      payload: { taskId, status: 'stopped' }
    })
  })
})
