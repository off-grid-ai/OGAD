/**
 * The AX (Accessibility) rail end to end, on a Mac. Everything of ours runs for real: admission,
 * settings, the model inventory, the Decision runtime, the element loop and its rule-based
 * decisions, the bounded writer, frame capture, vision recovery escalation, the vision
 * controller and task history. The boundaries are the Mac (harness/fake-mac-desktop: the
 * Accessibility and capture helpers, and the macOS commands), the input device
 * (harness/fake-input-device: nut.js, so this Mac's mouse and keyboard are never touched), the
 * Decider's llama-server executable, Electron, and the vision recovery the caller hands in.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeInputDevice, type FakeInputDevice } from './harness/fake-input-device'
import {
  installFakeMacDesktop,
  type DesktopElement,
  type FakeMacDesktop
} from './harness/fake-mac-desktop'
import {
  installFakeLlamaEngine,
  processAlive,
  unusedPort,
  useModelBrain,
  writeGguf,
  type BrainRequest,
  type FakeLlamaEngine,
  type ModelBrain
} from './harness/fake-llama-engine'
import { holdDecisionPorts } from './harness/decision-port-lock'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ax-host-'))
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
  return { surface, sent: [] as Array<{ channel: string; payload: unknown }> }
})
vi.mock('electron', () => {
  const display = {
    id: 1,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    workArea: { x: 0, y: 0, width: 800, height: 600 },
    scaleFactor: 1
  }
  const app = {
    getPath: () => process.env.OFFGRID_DATA_DIR,
    isPackaged: false,
    getAppPath: () => process.cwd()
  }
  // The supervisor window is an inert surface; the renderer's window records what it is sent.
  const BrowserWindow = Object.assign(
    function BrowserWindow() {
      return ui.surface
    },
    {
      getAllWindows: () => [
        {
          isDestroyed: () => false,
          webContents: {
            isDestroyed: () => false,
            send: (channel: string, payload: unknown) => ui.sent.push({ channel, payload })
          }
        }
      ]
    }
  )
  return {
    app,
    BrowserWindow,
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
    ipcMain: { on: () => {}, handle: () => {}, removeHandler: () => {} },
    shell: { openExternal: async () => {} }
  }
})
vi.mock('node:child_process', async (importOriginal) => {
  const { macOsCommands } = await import('./harness/fake-mac-desktop')
  return macOsCommands(await importOriginal<typeof import('node:child_process')>())
})

import {
  getAxRailHost,
  makeElementActuator,
  snapshotAccessibilityApp
} from '../accessibility/ax-host'
import { hasActiveVisionSession, stopVisionTask } from '../vision/vision-controller'
import { VisionGuard } from '../vision/vision-guard'
import { loadActuation } from '../input/actuation'
import { getComputerUseSettings, setComputerUseSettings } from '../computer-use-settings'
import { DECIDER_2B, importLocalModel, setActiveModel } from '../models-manager'
import { llm } from '../llm'
import { decisionRuntime } from '../accessibility/decision-runtime'
import type { TaskExecutionPhase } from '../../shared/task-execution-plan'
import type { TaskRetryCheckpoint } from '../tasks/task-retry'
import type { AxElement } from '../accessibility/ax-elements'

let desktop: FakeMacDesktop
let input: FakeInputDevice
let engine: FakeLlamaEngine
let brain: ModelBrain

// Other test files that start Decision servers take turns with this one, file by file. Taken while
// the file loads, so a wait for another file's turn is never a test's or hook's time.
const releasePorts = await holdDecisionPorts()
afterAll(releasePorts)
/** The reasoning model's answer to each request; the default is set per test. */
let reason: (request: BrainRequest) => string = () => ''

/** The reasoning model, as a careful one answers the milestone check: complete when the screen
 *  shows it. */
const verifyFromScreen = (proof: string, summary: string) => (request: BrainRequest) =>
  request.prompt.includes(proof)
    ? JSON.stringify({ action: 'milestone_complete', summary })
    : JSON.stringify({ action: 'vision_required', why: 'Not visible yet.' })

/** Put a window on the desktop with these controls. */
function showWindow(app: string, elements: DesktopElement[]): void {
  desktop.write((state) => {
    state.running = [...new Set([...state.running, app])]
    state.windows[app] = { title: app, elements }
  })
}

const field = (role: string, label: string, value = ''): DesktopElement => ({
  role,
  label,
  value,
  x: 10,
  y: 10,
  w: 300,
  h: 40
})

/** A run that resumes from a saved plan, as Continue and a planned task do. */
const planned = (
  taskId: string,
  phase: TaskExecutionPhase
): { checkpoint: TaskRetryCheckpoint } => ({
  checkpoint: { taskId, steps: [], plan: { version: 1, phases: [phase] } }
})

const typed = (): string =>
  input.events
    .filter((event) => event.kind === 'type')
    .map((event) => String(event.detail))
    .join('')

beforeAll(async () => {
  // A Mac: the Accessibility backend and the capture helper are macOS's.
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  desktop = await installFakeMacDesktop(bin)
  // Typing goes into the window's text field, as a real field takes it.
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
  brain = await useModelBrain(engine, (request) => {
    return reason(request)
  })
  writeGguf(llm.getModelsDir(), DECIDER_2B.files[0]!.name)
  // The chat (reasoning) model: a local model in the shared engine.
  const chat = await importLocalModel(writeGguf(path.join(root, 'fixtures'), 'chat.gguf'))
  expect(await setActiveModel(chat.id!)).toEqual({ success: true })
  ;(llm as unknown as { port: number }).port = await unusedPort()
  setComputerUseSettings({
    ...getComputerUseSettings(),
    modelStrategy: 'decision_plus_reasoning',
    decisionModelId: DECIDER_2B.id
  })
})

beforeEach(async () => {
  input.events.length = 0
  ui.sent.length = 0
})

afterEach(async () => {
  await decisionRuntime.shutdown()
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

const lastState = (taskId: string): Record<string, unknown> | undefined =>
  ui.sent
    .filter(
      ({ channel, payload }) =>
        channel === 'vision:task-state' && (payload as { taskId?: string }).taskId === taskId
    )
    .at(-1)?.payload as Record<string, unknown> | undefined

describe('AX host lifecycle', () => {
  it('admits a safe task, writes the planned text into the field, and releases its owners', async () => {
    showWindow('Notes', [field('AXTextField', 'Body')])
    reason = verifyFromScreen('value="hello"', 'The note says hello.')
    const result = await getAxRailHost().runTask(
      'Write hello in the note',
      'task-1',
      'Notes',
      (await snapshotAccessibilityApp('Notes')) ?? undefined,
      planned('task-1', {
        id: 'phase-1',
        title: 'Write hello',
        operation: { kind: 'type', value: 'hello' },
        completion: { kind: 'field_value', value: 'hello' }
      })
    )

    expect(result.ok).toBe(true)
    expect(typed()).toBe('hello')
    expect(desktop.read().windows.Notes!.elements[0]!.value).toBe('hello')
    // The Decision model was started for the run, and the run let go of its session.
    expect(engine.launches().length).toBeGreaterThan(0)
    expect(hasActiveVisionSession('task-1')).toBe(false)
    expect(lastState('task-1')).toMatchObject({ status: 'done' })
  })

  it('converts an unavailable vision recovery into an actionable failure', async () => {
    showWindow('Canvas', [])
    await expect(
      getAxRailHost().runTask(
        'Open canvas item',
        'task-2',
        'Canvas',
        (await snapshotAccessibilityApp('Canvas')) ?? undefined,
        {
          ...planned('task-2', { id: 'phase-1', title: 'Open the canvas item' })
        }
      )
    ).resolves.toMatchObject({
      ok: false,
      summary: expect.stringContaining('Vision recovery is unavailable')
    })
    expect(input.events).toEqual([])
  })

  it('refuses planned text for a private field and hands it to the person', async () => {
    showWindow('Login', [field('AXSecureTextField', 'Password')])
    const run = getAxRailHost().runTask(
      'Log in',
      'task-private',
      'Login',
      (await snapshotAccessibilityApp('Login')) ?? undefined,
      planned('task-private', {
        id: 'phase-secret',
        title: 'Enter the secret',
        operation: { kind: 'type', value: 'do-not-type' }
      })
    )
    // It waits for the person, saying why, and types nothing.
    await vi.waitFor(() =>
      expect(lastState('task-private')).toMatchObject({
        status: 'waiting',
        currentAction: 'The field needs private input.'
      })
    )
    stopVisionTask('task-private', 'Stopped by the user', 'Stopped')
    expect((await run).ok).toBe(false)
    expect(typed()).toBe('')
    expect(desktop.read().windows.Login!.elements[0]!.value).toBe('')
  })

  it('escalates a failed specialist recovery to the heavy reasoner', async () => {
    showWindow('Canvas', [])
    reason = verifyFromScreen('value="done"', 'The item is open.')
    const recover = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, detail: 'no grounded action' })
      .mockImplementationOnce(async () => {
        // The reasoner's visual action worked: the field now shows the result.
        showWindow('Canvas', [field('AXTextField', 'Title', 'done')])
        return { ok: true, performedActions: [{ type: 'key', keys: 'Enter' }] }
      })
    await expect(
      getAxRailHost().runTask(
        'Open the visible item',
        'task-recovery',
        'Canvas',
        (await snapshotAccessibilityApp('Canvas')) ?? undefined,
        {
          ...planned('task-recovery', {
            id: 'phase-1',
            title: 'Open the visible item',
            completion: { kind: 'field_value', value: 'done' }
          }),
          recoverWithVision: recover
        }
      )
    ).resolves.toMatchObject({ ok: true })
    expect(recover).toHaveBeenCalledTimes(2)
    expect(recover.mock.calls[0]?.[1]).toMatchObject({ specialistOnly: true })
    expect(recover.mock.calls[1]?.[1]).toMatchObject({ reasonerOnly: true })
  })
})

describe('the AX element actuator', () => {
  const element = (role: string, name: string, value = ''): AxElement => ({
    index: 1,
    role,
    name,
    value,
    cx: 120,
    cy: 80,
    enabled: true,
    actionable: true
  })

  function actuator(app: string): {
    act: ReturnType<typeof makeElementActuator>
    actions: string[]
  } {
    const guard = new VisionGuard({ taskId: `actuator-${app}`, kind: 'computer_use' })
    guard.markObservationReady()
    const actions: string[] = []
    return {
      act: makeElementActuator(loadActuation()!, guard, app, (action) => actions.push(action)),
      actions
    }
  }

  it('clicks, hovers, presses and scrolls at the element', async () => {
    const { act, actions } = actuator('Notes')
    const message = element('AXTextField', 'Message', 'old text')
    await act.click(message)
    await act.hover!(message)
    await act.press!(message)
    await act.scroll!(message, 'up')
    await act.scroll!(message, 'down')
    await act.scroll!(message, 'left')
    await act.scroll!(message, 'right')

    expect(input.events.filter(({ kind }) => kind === 'move').map(({ detail }) => detail)).toEqual(
      Array(7).fill(expect.objectContaining({ x: 120, y: 80 }))
    )
    expect(input.events.filter(({ kind }) => kind === 'click')).toHaveLength(2)
    expect(
      input.events.filter(({ kind }) => kind === 'scroll').map(({ detail }) => detail)
    ).toEqual([
      ['up', 240],
      ['down', 240],
      ['left', 240],
      ['right', 240]
    ])
    expect(actions).toEqual([
      'Click Message',
      'Open Message',
      'Press Message',
      'Scroll up in Message',
      'Scroll down in Message',
      'Scroll left in Message',
      'Scroll right in Message'
    ])
  })

  it('types into a field (replacing its text), into the focused field, and presses keys', async () => {
    const { act } = actuator('Notes')
    await act.type(element('AXTextField', 'Message', 'old text'), 'new')
    await act.type(null, 'more')
    await act.keys('Enter')

    expect(typed()).toBe('newmore')
    // Select-all before replacing existing text, then Enter.
    expect(input.events.filter(({ kind }) => kind === 'press')).toHaveLength(2)
  })

  it('sets a slider through the Accessibility helper', async () => {
    const { act, actions } = actuator('Settings')
    await act.setValue!(element('AXSlider', 'Volume', '50'), 75)
    expect(desktop.read().log).toContain('--set-slider-value Settings 120 80 75')
    expect(actions).toEqual(['Set Volume to 75'])
  })
})
