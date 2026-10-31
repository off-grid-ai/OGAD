// Continue runs in the same task context as a new run of its kind. The retry IPC, retry service,
// privacy gate, settings, remote model servers, pairing and browser hosts are real, in a temp
// profile. The boundaries: Electron (IPC, an inert browser view) and the paired browser at the far
// end of its socket.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-task-retry-context-'))
const previousDataDir = process.env.OFFGRID_DATA_DIR
process.env.OFFGRID_DATA_DIR = profile

const electron = vi.hoisted(() => {
  const surface: unknown = new Proxy(function inertSurface() {}, {
    get: (_target, key) =>
      key === 'then' ? undefined : key === Symbol.toPrimitive ? () => '' : surface,
    apply: () => surface,
    construct: () => surface as object
  })
  return { inert: surface, handlers: new Map<string, (...args: unknown[]) => unknown>() }
})
vi.mock('electron', () => ({
  WebContentsView: electron.inert,
  session: electron.inert,
  app: {
    getPath: () => process.env.OFFGRID_DATA_DIR,
    isPackaged: false,
    getAppPath: () => process.cwd()
  },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  ipcMain: {
    on: () => {},
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler)
  }
}))

import { registerTaskHistoryIpc } from '../task-history-ipc'
import { configureTaskExecutionDevice, getTaskRun, recordTaskRun } from '../task-history'
import { getComputerUseSettings, setComputerUseSettings } from '../../computer-use-settings'
import { setWebUseSettings } from '../../web-use-settings'
import { setRemoteVisionServerSettings } from '../../vision/remote-vision-server'
import { addBrowserLink, getBridgeService } from '../../extension-bridge/bridge-electron'
import { exportPublicKey, generateKeyPair } from '../../extension-bridge/bridge-protocol'
import type { BrowserLink } from '../../extension-bridge/bridge-socket'

/** What the paired browser was asked over its socket. */
const asked: string[] = []

beforeAll(async () => {
  configureTaskExecutionDevice({ id: 'mac-1', name: 'My Mac' })
  // Chat runs on a remote server that may not see the screen. Computer Use uses the chat model
  // (so it would be refused); Web Use uses a specialist and no remote server (so it may run).
  setRemoteVisionServerSettings({
    provider: 'custom',
    endpoint: 'http://127.0.0.1:9/v1',
    model: 'remote-chat',
    serverId: 'remote-chat',
    name: 'Remote chat',
    screenFramesAllowed: false
  })
  setComputerUseSettings({ ...getComputerUseSettings(), modelStrategy: 'same_as_chat' })
  setWebUseSettings({ modelStrategy: 'separate_specialist', browserTarget: 'default_browser' })
  // A browser paired and connected the way the extension does it.
  const browser = await generateKeyPair()
  const reply = await (
    await getBridgeService()
  ).pair({ v: 1, publicKey: await exportPublicKey(browser.publicKey), deviceName: 'Chrome' })
  const id = (reply.body as { deviceId: string }).deviceId
  const link: BrowserLink = {
    browser: { id, name: 'Chrome extension', publicKey: 'k', pairedAt: Date.now() },
    async request(op) {
      asked.push(op)
      throw new Error('This browser closed the page.')
    },
    onEvent: () => () => undefined,
    onClose: () => () => undefined,
    close: () => undefined
  }
  addBrowserLink(link)
  registerTaskHistoryIpc()
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('Continue', () => {
  it('runs a web task with the Web Use model settings, never the Computer Use ones', async () => {
    // A web task that stopped on this Mac, as the task loop records it.
    recordTaskRun({
      taskId: 'task-1',
      journeyId: 'j-1',
      kind: 'web_use',
      title: 'Find the release notes',
      status: 'failed',
      summary: 'The page did not load.',
      steps: ['Opened the page'],
      lastUrl: 'https://example.com',
      executionDeviceId: 'mac-1',
      executionDeviceName: 'My Mac'
    })

    const retry = electron.handlers.get('tasks:retry')!
    expect(await retry({}, 'task-1')).toMatchObject({ available: true })

    // It reached the paired browser: the Web Use settings let it run, where the Computer Use
    // ones (the remote chat model, no screen frames) would have refused it.
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0))
    await vi.waitFor(() => expect(getTaskRun('task-1')?.status).not.toBe('running'))
    expect(getTaskRun('task-1')?.summary ?? '').not.toMatch(/screen/i)
  })

  it('is refused before the browser when the Web Use settings send the screen to that server', async () => {
    setWebUseSettings({ modelStrategy: 'same_as_chat', browserTarget: 'default_browser' })
    recordTaskRun({
      taskId: 'task-2',
      journeyId: 'j-2',
      kind: 'web_use',
      title: 'Find the changelog',
      status: 'failed',
      summary: 'The page did not load.',
      steps: ['Opened the page'],
      executionDeviceId: 'mac-1',
      executionDeviceName: 'My Mac'
    })
    const before = asked.length

    await electron.handlers.get('tasks:retry')!({}, 'task-2')

    await vi.waitFor(() => expect(getTaskRun('task-2')?.status).toBe('failed'))
    expect(asked).toHaveLength(before)
  })
})
