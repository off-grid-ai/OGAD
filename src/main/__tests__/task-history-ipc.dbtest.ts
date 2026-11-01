/**
 * The task history IPC and Continue routing, on a Mac. The IPC handlers, task history, retry
 * service, privacy gate, both browser hosts, the AX host and the vision host are real. The
 * boundaries: Electron, the Mac (harness/fake-mac-desktop), the input device
 * (harness/fake-input-device: this Mac's mouse and keyboard are never touched), the paired
 * browser at the far end of its socket, and the chat model's llama-server executable, whose
 * replies come from this test.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeInputDevice, type FakeInputDevice } from './harness/fake-input-device'
import { installFakeMacDesktop, type FakeMacDesktop } from './harness/fake-mac-desktop'
import {
  installFakeLlamaEngine,
  processAlive,
  unusedPort,
  useModelBrain,
  writeGguf,
  type BrainReply,
  type BrainRequest,
  type FakeLlamaEngine,
  type ModelBrain
} from './harness/fake-llama-engine'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-task-history-ipc-'))
const bin = path.join(root, 'bin')
const previous = {
  data: process.env.OFFGRID_DATA_DIR,
  bin: process.env.OFFGRID_BIN_DIR,
  platform: Object.getOwnPropertyDescriptor(process, 'platform')!
}
process.env.OFFGRID_DATA_DIR = path.join(root, 'profile')
process.env.OFFGRID_BIN_DIR = bin

const ui = vi.hoisted(() => {
  const surface: unknown = new Proxy(function inertSurface() {}, {
    get: (_target, key) =>
      key === 'then' ? undefined : key === Symbol.toPrimitive ? () => '' : surface,
    apply: () => surface,
    construct: () => surface as object
  })
  return {
    surface,
    sent: [] as Array<{ channel: string; payload: unknown }>,
    handlers: new Map<string, (...args: unknown[]) => unknown>()
  }
})
vi.mock('electron', () => {
  const display = {
    id: 1,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    workArea: { x: 0, y: 0, width: 800, height: 600 },
    scaleFactor: 1
  }
  const BrowserWindow = Object.assign(
    function BrowserWindow() {
      return ui.surface
    },
    {
      getAllWindows: () => [
        {
          isDestroyed: () => false,
          show: () => {},
          focus: () => {},
          webContents: {
            isDestroyed: () => false,
            send: (channel: string, payload: unknown) => ui.sent.push({ channel, payload })
          }
        }
      ]
    }
  )
  return {
    app: {
      getPath: () => process.env.OFFGRID_DATA_DIR,
      isPackaged: false,
      getAppPath: () => process.cwd()
    },
    BrowserWindow,
    WebContentsView: ui.surface,
    session: ui.surface,
    safeStorage: { isEncryptionAvailable: () => false },
    systemPreferences: {
      isTrustedAccessibilityClient: () => true,
      getMediaAccessStatus: () => 'granted'
    },
    screen: {
      getAllDisplays: () => [display],
      getPrimaryDisplay: () => display,
      getDisplayNearestPoint: () => display,
      getCursorScreenPoint: () => ({ x: 1, y: 1 })
    },
    desktopCapturer: { getSources: async () => [] },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    ipcMain: {
      on: () => {},
      removeHandler: () => {},
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        ui.handlers.set(channel, handler)
    },
    shell: { openExternal: async () => {} }
  }
})
vi.mock('node:child_process', async (importOriginal) => {
  const { macOsCommands } = await import('./harness/fake-mac-desktop')
  return macOsCommands(await importOriginal<typeof import('node:child_process')>())
})

import { registerTaskHistoryIpc } from '../tasks/task-history-ipc'
import { configureTaskExecutionDevice, getTaskRun, recordTaskRun } from '../tasks/task-history'
import { getComputerUseSettings, setComputerUseSettings } from '../computer-use-settings'
import { setWebUseSettings } from '../web-use-settings'
import { DECIDER_2B, importLocalModel, setActiveModel } from '../models-manager'
import { decisionRuntime } from '../accessibility/decision-runtime'
import { holdDecisionPorts } from './harness/decision-port-lock'
import { llm } from '../llm'
import { addBrowserLink, getBridgeService } from '../extension-bridge/bridge-electron'
import { exportPublicKey, generateKeyPair } from '../extension-bridge/bridge-protocol'
import type { BrowserLink } from '../extension-bridge/bridge-socket'

// Other test files that start Decision servers take turns with this one, file by file. Taken while
// the file loads, so a wait for another file's turn is never a test's or hook's time.
const releasePorts = await holdDecisionPorts()
afterAll(releasePorts)

let desktop: FakeMacDesktop
let input: FakeInputDevice
let engine: FakeLlamaEngine
let brain: ModelBrain
const browserAsked: string[] = []

/** The chat model: plans, writes text and checks milestones the way a careful model does. */
function answer(request: BrainRequest): BrainReply {
  if (request.prompt.includes('Independently verify the current milestone'))
    return request.prompt.includes('value="hello"')
      ? JSON.stringify({ action: 'milestone_complete', summary: 'The note says hello.' })
      : JSON.stringify({ action: 'vision_required', why: 'Not written yet.' })
  if (/execution plan/i.test(request.prompt))
    return JSON.stringify({
      phases: [
        { title: 'Write hello', operation: { kind: 'type', target: 'Body', value: 'hello' } }
      ]
    })
  return JSON.stringify({ fill: true, text: 'hello', submit: false })
}

const typed = (): string =>
  input.events
    .filter((event) => event.kind === 'type')
    .map((event) => String(event.detail))
    .join('')

/** A task that stopped on this Mac, as the task loop records it. */
function failedTask(taskId: string, kind: 'web_use' | 'computer_use', title: string): void {
  recordTaskRun({
    taskId,
    journeyId: `journey-${taskId}`,
    kind,
    title,
    status: 'failed',
    summary: 'It stopped.',
    steps: ['Started'],
    executionDeviceId: 'mac-1',
    executionDeviceName: 'My Mac'
  })
}

const settled = async (taskId: string): Promise<void> =>
  vi.waitFor(() => expect(getTaskRun(taskId)?.status).not.toBe('running'), { timeout: 10_000 })

beforeAll(async () => {
  // Load the Web Use host while the platform is still this machine's: its native libraries
  // (onnxruntime under transformers.js) pick their binary by platform, as they do in the app.
  // Only the fake Mac desktop below needs darwin. The host loads transformers.js only when a run
  // starts, so it loads here too, before the platform reads darwin.
  await import('../browser/web-use-host')
  await import('@huggingface/transformers')
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  configureTaskExecutionDevice({ id: 'mac-1', name: 'My Mac' })
  desktop = await installFakeMacDesktop(bin)
  input = await installFakeInputDevice((event) => {
    if (event.kind !== 'type') return
    desktop.write((state) => {
      for (const window of Object.values(state.windows)) {
        const target = window.elements.find((element) => /TextField/.test(element.role))
        if (target) target.value = `${target.value ?? ''}${String(event.detail)}`
      }
    })
  })
  engine = installFakeLlamaEngine(bin)
  brain = await useModelBrain(engine, answer)
  const chat = await importLocalModel(writeGguf(path.join(root, 'fixtures'), 'chat.gguf'))
  expect(await setActiveModel(chat.id!)).toEqual({ success: true })
  ;(llm as unknown as { port: number }).port = await unusedPort()
  writeGguf(llm.getModelsDir(), DECIDER_2B.files[0]!.name)
  setComputerUseSettings({
    ...getComputerUseSettings(),
    modelStrategy: 'decision_plus_reasoning',
    decisionModelId: DECIDER_2B.id
  })
  setWebUseSettings({ modelStrategy: 'separate_specialist', browserTarget: 'default_browser' })
  // A paired browser, connected the way the extension connects.
  const browser = await generateKeyPair()
  const reply = await (
    await getBridgeService()
  ).pair({ v: 1, publicKey: await exportPublicKey(browser.publicKey), deviceName: 'Chrome' })
  const link: BrowserLink = {
    browser: {
      id: (reply.body as { deviceId: string }).deviceId,
      name: 'Chrome extension',
      publicKey: 'k',
      pairedAt: Date.now()
    },
    async request(op) {
      browserAsked.push(op)
      throw new Error('This browser closed the page.')
    },
    onEvent: () => () => undefined,
    onClose: () => () => undefined,
    close: () => undefined
  }
  addBrowserLink(link)
  registerTaskHistoryIpc()
})

beforeEach(() => {
  input.events.length = 0
})

afterAll(async () => {
  llm.stop()
  await brain.close()
  for (const { pid } of engine.launches()) if (processAlive(pid)) process.kill(pid, 'SIGKILL')
  Object.defineProperty(process, 'platform', previous.platform)
  if (previous.data === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previous.data
  if (previous.bin === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = previous.bin
  fs.rmSync(root, { recursive: true, force: true })
})

describe('task history IPC composition', () => {
  it('registers list and remove handlers with validated arguments, and the retry and guide channels', () => {
    failedTask('listed-1', 'web_use', 'Read the news')
    failedTask('listed-2', 'web_use', 'Read the weather')
    const list = ui.handlers.get('tasks:list')!
    const remove = ui.handlers.get('tasks:remove')!

    const ids = (value: unknown): string[] =>
      (value as Array<{ taskId: string }>).map(({ taskId }) => taskId)
    expect(ids(list({}, 1))).toHaveLength(1)
    expect(ids(list({}, 'all'))).toEqual(expect.arrayContaining(['listed-1', 'listed-2']))
    expect(remove({}, ['listed-1', 42])).toEqual(['listed-1'])
    expect(remove({}, null)).toEqual([])
    expect(getTaskRun('listed-1')).toBeUndefined()
    for (const channel of ['tasks:retry', 'tasks:retry-availability', 'tasks:guide'])
      expect(ui.handlers.has(channel)).toBe(true)
  })

  it('continues a web task in the browser Tasks > Web Use picks', async () => {
    failedTask('web-1', 'web_use', 'Find the release notes')
    expect(await ui.handlers.get('tasks:retry')!({}, 'web-1')).toMatchObject({ available: true })
    await settled('web-1')
    // The connected default browser, not Off Grid AI's own. On failure, say how the run ended.
    expect(browserAsked.length, getTaskRun('web-1')?.summary).toBeGreaterThan(0)
  })

  it('continues a computer task on the AX rail when its app shows usable controls', async () => {
    desktop.write((state) => {
      state.running = ['Notes']
      state.windows.Notes = {
        title: 'Notes',
        elements: [{ role: 'AXTextField', label: 'Body', value: '', x: 10, y: 10, w: 300, h: 40 }]
      }
    })
    failedTask('cu-ax', 'computer_use', 'Write hello in Notes')

    try {
      await ui.handlers.get('tasks:retry')!({}, 'cu-ax')
      await settled('cu-ax')
    } finally {
      await decisionRuntime.shutdown()
    }

    expect(desktop.read().log).toContain('--elements Notes')
    expect(typed()).toBe('hello')
    expect(getTaskRun('cu-ax')?.status).toBe('done')
  })

  it('continues a computer task on the vision rail when no app can be targeted', async () => {
    const before = desktop.read().log.length
    failedTask('cu-vision', 'computer_use', 'Tidy up whatever is on screen')

    await ui.handlers.get('tasks:retry')!({}, 'cu-vision')
    await settled('cu-vision')

    // No app's controls were read or acted on; the screen went to the vision rail.
    expect(
      desktop
        .read()
        .log.slice(before)
        .some((entry) => entry.startsWith('--elements'))
    ).toBe(false)
    expect(typed()).toBe('')
    // The vision rail answered: it needs a vision model, which this Mac's chat model is not.
    expect(getTaskRun('cu-vision')?.summary).toBe(
      'The active general vision model has no installed vision projector.'
    )
  })
})
