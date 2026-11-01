// Which browser a web task runs in. The settings, the pairing, the live-link registry, both browser
// hosts and the task history are real, in a temp profile. The boundaries: Electron, and the paired
// browser at the far end of its socket (an in-memory link that records what it is asked).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-web-use-host-'))
const previousDataDir = process.env.OFFGRID_DATA_DIR
process.env.OFFGRID_DATA_DIR = profile

// Electron's own browser view: an inert surface that accepts every call. Off Grid AI's browser
// host builds on it; nothing here renders.
const inert = vi.hoisted((): unknown => {
  const surface: unknown = new Proxy(function inertSurface() {}, {
    get: (_target, key) =>
      key === 'then' ? undefined : key === Symbol.toPrimitive ? () => '' : surface,
    apply: () => surface,
    construct: () => surface as object
  })
  return surface
})

vi.mock('electron', () => ({
  WebContentsView: inert,
  session: inert,
  app: {
    getPath: () => process.env.OFFGRID_DATA_DIR,
    isPackaged: false,
    getAppPath: () => process.cwd()
  },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] },
  // The person approves the pairing.
  dialog: { showMessageBox: async () => ({ response: 0 }) },
  ipcMain: { on: () => {}, handle: () => {} }
}))

import { getWebUseRailHost } from '../web-use-host'
import { DEFAULT_BROWSER_FALLBACK_NOTE } from '../../../shared/web-use-settings'
import { setWebUseSettings } from '../../web-use-settings'
import { addBrowserLink, getBridgeService } from '../../extension-bridge/bridge-electron'
import { exportPublicKey, generateKeyPair } from '../../extension-bridge/bridge-protocol'
import type { BrowserLink } from '../../extension-bridge/bridge-socket'
import { getTaskRun } from '../../tasks/task-history'

/** What the paired browser was asked over its socket: op and tab. */
const asked: Array<{ op: string; tabId: unknown }> = []
let pairedId = ''

/** The paired browser's live link, as the socket handshake hands it over. */
function connectBrowser(): void {
  const link: BrowserLink = {
    browser: { id: pairedId, name: 'Chrome extension', publicKey: 'k', pairedAt: Date.now() },
    async request(op, args = {}) {
      asked.push({ op, tabId: (args as { tabId?: unknown }).tabId })
      throw new Error('This browser closed the page.')
    },
    onEvent: () => () => undefined,
    onClose: () => () => undefined,
    close: () => undefined
  }
  addBrowserLink(link)
}

const request = { goal: 'Find the release notes', journeyId: 'journey-1' }
let taskNumber = 0
const task = (): typeof request & { taskId: string } => ({
  ...request,
  taskId: `task-${++taskNumber}`
})

beforeAll(async () => {
  // Paired the way the browser pairs: it asks, the person approves.
  const browser = await generateKeyPair()
  const reply = await (
    await getBridgeService()
  ).pair({ v: 1, publicKey: await exportPublicKey(browser.publicKey), deviceName: 'Chrome' })
  pairedId = (reply.body as { deviceId: string }).deviceId
  expect(pairedId).toBeTruthy()
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
  fs.rmSync(profile, { recursive: true, force: true })
})

beforeEach(() => {
  asked.length = 0
  setWebUseSettings({ browserTarget: 'default_browser' })
})

describe('web task browser choice', () => {
  it('runs here when the default browser is chosen but none is connected, and says so', async () => {
    const run = task()
    await getWebUseRailHost()
      .runTask(run)
      .catch(() => undefined)
    expect(asked).toEqual([])
    expect(getTaskRun(run.taskId)?.steps).toContain(DEFAULT_BROWSER_FALLBACK_NOTE)
  })

  it('runs in the connected browser when the default browser is chosen', async () => {
    connectBrowser()
    const run = task()
    await getWebUseRailHost()
      .runTask(run)
      .catch(() => undefined)
    expect(asked.length).toBeGreaterThan(0)
    expect(getTaskRun(run.taskId)?.steps ?? []).not.toContain(DEFAULT_BROWSER_FALLBACK_NOTE)
  })

  it('adds no note when the Off Grid AI browser is the choice', async () => {
    setWebUseSettings({ browserTarget: 'in_app' })
    connectBrowser()
    const run = task()
    await getWebUseRailHost()
      .runTask(run)
      .catch(() => undefined)
    expect(asked).toEqual([])
    // It ran here (the task is on record), without the fallback note.
    expect(getTaskRun(run.taskId)).toBeDefined()
    expect(getTaskRun(run.taskId)?.steps ?? []).not.toContain(DEFAULT_BROWSER_FALLBACK_NOTE)
  })

  it('runs a task in the tab its own chat offered, whatever the setting', async () => {
    setWebUseSettings({ browserTarget: 'in_app' })
    await getWebUseRailHost()
      .runTask({ ...task(), startTab: { browserId: pairedId, tabId: 42 } })
      .catch(() => undefined)
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every(({ tabId }) => tabId === undefined || tabId === 42)).toBe(true)
    expect(asked.some(({ tabId }) => tabId === 42)).toBe(true)
  })
})
