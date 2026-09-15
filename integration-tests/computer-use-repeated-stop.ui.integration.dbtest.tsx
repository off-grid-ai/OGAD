// @vitest-environment jsdom

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// The DB Vitest config uses the classic JSX transform, which reads this binding at runtime.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown
type IpcListener = (event: unknown, ...args: unknown[]) => void

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-computer-use-stop-'))
const previousDataDir = process.env.OFFGRID_DATA_DIR
const electron = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  listeners: new Map<string, Set<IpcListener>>(),
  heldEvents: [] as Array<{ channel: string; payload: unknown }>,
  holdEvents: false
}))

function emitToRenderer(channel: string, payload: unknown): void {
  for (const listener of electron.listeners.get(channel) ?? []) listener({}, payload)
}

vi.mock('electron', () => ({
  app: { getPath: () => profile, isPackaged: false, getAppPath: () => process.cwd() },
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: unknown) => {
            if (electron.holdEvents) electron.heldEvents.push({ channel, payload })
            else emitToRenderer(channel, payload)
          }
        }
      }
    ]
  },
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => {
      Object.defineProperty(window, name, { configurable: true, writable: true, value })
    }
  },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => electron.handlers.set(channel, handler)
  },
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = electron.handlers.get(channel)
      if (handler) return handler({}, ...args)
      if (channel === 'browser:get-sessions') return { activeSessionId: null, sessions: [] }
      if (channel === 'browser:list-manual-history') return []
      throw new Error(`No production IPC handler registered for ${channel}`)
    },
    on: (channel: string, listener: IpcListener) => {
      const listeners = electron.listeners.get(channel) ?? new Set<IpcListener>()
      listeners.add(listener)
      electron.listeners.set(channel, listeners)
    },
    removeListener: (channel: string, listener: IpcListener) => {
      electron.listeners.get(channel)?.delete(listener)
    },
    removeAllListeners: (channel: string) => electron.listeners.delete(channel),
    send: () => undefined,
    sendSync: () => false
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

let WatchedBrowserPane: typeof import('../pro/renderer/components/browser/WatchedBrowserPane').WatchedBrowserPane
let controller: typeof import('../src/main/vision/vision-controller')
let VisionGuard: typeof import('../src/main/vision/vision-guard').VisionGuard

beforeAll(async () => {
  process.env.OFFGRID_DATA_DIR = profile
  const taskHistory = await import('../src/main/tasks/task-history')
  taskHistory.configureTaskExecutionDevice({ id: 'test-mac', name: 'Test Mac' })
  const { registerTaskHistoryIpc } = await import('../src/main/tasks/task-history-ipc')
  registerTaskHistoryIpc()
  controller = await import('../src/main/vision/vision-controller')
  controller.registerVisionIpc()
  ;({ VisionGuard } = await import('../src/main/vision/vision-guard'))
  await import('../src/preload/index')
  ;({ WatchedBrowserPane } = await import('../pro/renderer/components/browser/WatchedBrowserPane'))
})

afterAll(async () => {
  cleanup()
  const { getDB } = await import('../src/main/database')
  if (getDB().open) getDB().close()
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('Computer Use repeated Stop', () => {
  it('accepts two Stop actions without showing an error', async () => {
    const taskId = 'repeated-stop-task'
    const guard = new VisionGuard({ taskId, kind: 'computer_use' })
    const dispose = controller.registerVisionSession(taskId, guard, new AbortController())
    controller.emitVisionState({
      taskId,
      goal: 'Stop this task safely',
      status: 'running',
      phase: 'thinking'
    })

    render(<WatchedBrowserPane standalone />)
    const firstStop = await screen.findByRole('button', { name: 'Stop' })

    electron.holdEvents = true
    fireEvent.click(firstStop)
    await act(async () => Promise.resolve())
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await act(async () => Promise.resolve())

    expect(screen.queryByRole('alert')).toBeNull()

    electron.holdEvents = false
    await act(async () => {
      for (const event of electron.heldEvents.splice(0)) {
        emitToRenderer(event.channel, event.payload)
      }
    })
    await waitFor(() => expect(screen.getAllByText('stopped').length).toBeGreaterThan(0))
    expect(screen.queryByRole('alert')).toBeNull()

    dispose()
  })
})
