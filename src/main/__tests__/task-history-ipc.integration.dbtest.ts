/**
 * Task history through the production Desktop IPC composition. Shared automation, the Desktop
 * SQLite adapter, guidance policy, and handler registration stay real. Electron is the only fake:
 * Vitest has no main process in which to register IPC handlers or windows to notify.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OffGridApplication } from '@offgrid/application'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

type IpcHandler = (_event: unknown, ...args: unknown[]) => unknown

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-task-history-ipc-'))
const handlers = new Map<string, IpcHandler>()

vi.mock('electron', () => ({
  app: {
    getPath: () => profile,
    getAppPath: () => process.cwd(),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler)
  }
}))

const { getDB } = await import('../database')
const { registerDesktopApplication } = await import('../composition/application-access')
const { createDesktopAutomationPorts, getTaskRun, recordTaskRun } =
  await import('../tasks/task-history')
const { registerTaskGuideHandler, TASK_GUIDANCE_TRACE } = await import('../tasks/task-guide')
const { registerTaskHistoryIpc } = await import('../tasks/task-history-ipc')

let application: OffGridApplication
let releaseApplication: () => void

beforeAll(async () => {
  const [{ createOffGridApplication }, { desktopModelWorkspacePorts }] = await Promise.all([
    import('@offgrid/application'),
    import('../model-services')
  ])
  application = createOffGridApplication({
    models: desktopModelWorkspacePorts,
    automation: createDesktopAutomationPorts()
  })
  releaseApplication = registerDesktopApplication(application)
  await application.start()
  registerTaskHistoryIpc()
})

afterAll(async () => {
  await application.stop()
  releaseApplication()
  getDB().close()
  fs.rmSync(profile, { recursive: true, force: true })
})

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`IPC handler ${channel} was not registered.`)
  return handler({}, ...args)
}

describe('task history IPC through the real Desktop application', () => {
  it('lists durable task history with the renderer limit contract', async () => {
    recordTaskRun({ taskId: 'ipc-first', kind: 'web_use', title: 'First task', status: 'done' })
    recordTaskRun({
      taskId: 'ipc-second',
      kind: 'computer_use',
      title: 'Second task',
      status: 'done'
    })

    expect(invoke('tasks:list', 1)).toMatchObject([{ taskId: 'ipc-second' }])
    expect(invoke('tasks:list', 'invalid')).toMatchObject([
      { taskId: 'ipc-second' },
      { taskId: 'ipc-first' }
    ])
    await expect(invoke('tasks:retry-availability', 'missing-task')).resolves.toMatchObject({
      available: false
    })
    expect(invoke('tasks:retry-availability', 42)).toEqual({
      available: false,
      reason: 'This task is no longer in history.'
    })
  })

  it('accepts guidance through IPC and persists only the safe trace', async () => {
    recordTaskRun({ taskId: 'ipc-guide', kind: 'web_use', title: 'Guided task', status: 'running' })
    const received: string[] = []
    const releaseGuide = registerTaskGuideHandler('ipc-guide', (text) => {
      received.push(text)
      return true
    })

    await expect(invoke('tasks:guide-availability', 'ipc-guide')).resolves.toEqual({
      available: true
    })
    const privateGuidance = 'Use the private account named Aurora'
    await expect(invoke('tasks:guide', 'ipc-guide', { text: privateGuidance })).resolves.toEqual({
      available: true,
      accepted: true
    })
    expect(received).toEqual([privateGuidance])
    expect(getTaskRun('ipc-guide')?.steps).toContain(TASK_GUIDANCE_TRACE)
    expect(JSON.stringify(getTaskRun('ipc-guide'))).not.toContain('Aurora')

    expect(invoke('tasks:guide', 42, { text: 'ignored' })).toEqual({
      available: false,
      reason: 'This task is no longer available.'
    })
    releaseGuide()
  })
})
