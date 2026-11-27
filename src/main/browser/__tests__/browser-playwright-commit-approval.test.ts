/**
 * The semantic Web Use loop asks before send, pay and delete (browser-commit-gate.ts), and the
 * person's Continue runs the approved action. The loop, guard, commit gate, action dispatch and the
 * chat engine owner are real; the model's replies come from this test through the llama-server
 * executable (harness/fake-llama-engine), and the Playwright page is a boundary.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SemanticDecision } from '../browser-playwright-policy'
import {
  installFakeLlamaEngine,
  processAlive,
  unusedPort,
  useModelBrain,
  writeGguf,
  type FakeLlamaEngine,
  type ModelBrain
} from '../../__tests__/harness/fake-llama-engine'

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-web-commit-approval-'))
const previous = { data: process.env.OFFGRID_DATA_DIR, bin: process.env.OFFGRID_BIN_DIR }
process.env.OFFGRID_DATA_DIR = PROFILE
process.env.OFFGRID_BIN_DIR = fs.mkdtempSync(path.join(PROFILE, 'no-engines-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.OFFGRID_DATA_DIR,
    isPackaged: false,
    getAppPath: () => process.cwd()
  },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { VisionGuard } from '../../vision/vision-guard'
import { FOCUSED_SUBMIT_SCRIPT } from '../browser-commit-gate'
import { runBrowserPlaywrightTask } from '../browser-playwright-task'
import type { BrowserPlaywrightTaskInput } from '../browser-playwright-task-contract'
import type { PlaywrightToolResult, SemanticPageSession } from '../playwright-mcp-session'
import { llm } from '../../llm'
import { importLocalModel, setActiveModel } from '../../models-manager'

// The model: each step answers with the next queued decision.
const decisions: Array<Partial<SemanticDecision>> = []
let engine: FakeLlamaEngine
let brain: ModelBrain

beforeAll(async () => {
  const chat = await importLocalModel(writeGguf(path.join(PROFILE, 'fixtures'), 'chat.gguf'))
  expect(await setActiveModel(chat.id!)).toEqual({ success: true })
  const bin = path.join(PROFILE, 'bin')
  process.env.OFFGRID_BIN_DIR = bin
  engine = installFakeLlamaEngine(bin)
  brain = await useModelBrain(engine, () => {
    const next = decisions.shift()
    if (!next) throw new Error('The model has no queued decision.')
    return JSON.stringify(decision(next))
  })
  ;(llm as unknown as { port: number }).port = await unusedPort()
})

afterAll(async () => {
  llm.stop()
  await brain.close()
  for (const { pid } of engine.launches()) if (processAlive(pid)) process.kill(pid, 'SIGKILL')
  fs.rmSync(PROFILE, { recursive: true, force: true })
  if (previous.data === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previous.data
  if (previous.bin === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = previous.bin
})

function decision(overrides: Partial<SemanticDecision>): SemanticDecision {
  return {
    action: 'click',
    phase_id: 'phase-1',
    element: null,
    ref: null,
    text: null,
    key: null,
    values: null,
    start_element: null,
    start_ref: null,
    end_element: null,
    end_ref: null,
    url: null,
    evidence_ref: null,
    evidence_text: null,
    reason: '',
    summary: '',
    ...overrides
  }
}

/** A checkout page: a card field and the form's button. Enter or a click places the order. */
class CheckoutPage implements SemanticPageSession {
  button = 'Place order'
  placed = false
  readonly actions: string[] = []

  async snapshot(): Promise<PlaywrightToolResult> {
    return {
      text: [
        '- textbox "Card number" [ref=e1]',
        `- button "${this.button}" [ref=e2]`,
        ...(this.placed ? ['- status "Order placed" [ref=e3]'] : [])
      ].join('\n'),
      isError: false
    }
  }

  async recoverPage(): Promise<PlaywrightToolResult> {
    return this.snapshot()
  }

  async call(name: string, args: Record<string, unknown>): Promise<PlaywrightToolResult> {
    if (name === 'browser_evaluate' && args.function === FOCUSED_SUBMIT_SCRIPT) {
      const focus = { focused: '- textbox "Card number"', submit: `- button "${this.button}"` }
      return { text: `### Result\n${JSON.stringify(JSON.stringify(focus))}`, isError: false }
    }
    this.actions.push(`${name} ${JSON.stringify(args)}`)
    if (name === 'browser_click' && args.target === 'e2') this.placed = true
    if (name === 'browser_press_key' && args.key === 'Enter') this.placed = true
    return { text: 'ok', isError: false }
  }
}

function run(
  page: CheckoutPage,
  taskId: string,
  answer: (guard: VisionGuard, why: string) => void,
  extra: Partial<BrowserPlaywrightTaskInput> = {}
): { asked: string[]; steps: string[]; done: ReturnType<typeof runBrowserPlaywrightTask> } {
  const asked: string[] = []
  const steps: string[] = []
  const guard = new VisionGuard({ taskId, kind: 'web_use' })
  const done = runBrowserPlaywrightTask({
    goal: 'Place the order',
    plan: { version: 1, phases: [{ id: 'phase-1', title: 'Place the order' }] },
    session: page,
    guard,
    activeDriver: () => null,
    activeUrl: () => 'https://shop.test/checkout',
    waitForUser: async (why) => {
      asked.push(why)
      answer(guard, why)
    },
    takeGuidance: () => [],
    onStep: (note) => void steps.push(note),
    onPhase: () => undefined,
    onProgress: () => undefined,
    ...extra
  })
  return { asked, steps, done }
}

/** The person presses Continue in the app. */
function pressContinue(guard: VisionGuard, why: string): void {
  expect(guard.requestUser(why)).toBe(true)
  expect(guard.resume()).toBe(true)
}

const placed = { action: 'done' as const, evidence_text: 'Order placed', summary: 'Order placed.' }

beforeEach(() => {
  decisions.length = 0
})

describe('send, pay and delete in the semantic loop', () => {
  it('runs the approved click once the person presses Continue', async () => {
    const page = new CheckoutPage()
    decisions.push({ action: 'click', ref: 'e2', element: 'Place order' }, placed)
    const { asked, done } = run(page, 'semantic-commit-click', pressContinue)
    await expect(done).resolves.toMatchObject({ ok: true })
    expect(asked).toEqual(['Approve "Place order"? Press Continue to let it, or Stop.'])
    expect(page.actions.filter((action) => action.startsWith('browser_click'))).toHaveLength(1)
  })

  it('drops the approved click when the button changed while the question waited', async () => {
    const page = new CheckoutPage()
    decisions.push(
      { action: 'click', ref: 'e2', element: 'Place order' },
      { action: 'fallback', reason: 'The order changed.' }
    )
    const { steps, done } = run(page, 'semantic-commit-changed', (guard, why) => {
      page.button = 'Pay $500'
      pressContinue(guard, why)
    })
    await expect(done).resolves.toMatchObject({ ok: false, summary: 'The order changed.' })
    expect(page.actions).toEqual([])
    expect(steps).toContain('did not Place order: the page changed while waiting for approval')
  })

  it('asks before Enter submits a form whose default button places the order', async () => {
    const page = new CheckoutPage()
    decisions.push({ action: 'press_key', key: 'Enter' }, placed)
    const { asked, done } = run(page, 'semantic-commit-enter', pressContinue)
    await expect(done).resolves.toMatchObject({ ok: true })
    expect(asked).toEqual(['Approve "Place order"? Press Continue to let it, or Stop.'])
    expect(page.actions).toEqual(['browser_press_key {"key":"Enter"}'])
  })

  it('lets Enter submit an ordinary form without asking', async () => {
    const page = new CheckoutPage()
    page.button = 'Search'
    decisions.push({ action: 'press_key', key: 'Enter' }, placed)
    const { asked, done } = run(page, 'semantic-search-enter', pressContinue)
    await expect(done).resolves.toMatchObject({ ok: true })
    expect(asked).toEqual([])
    expect(page.actions).toEqual(['browser_press_key {"key":"Enter"}'])
  })

  it('goes straight on in a sandbox test profile', async () => {
    const page = new CheckoutPage()
    decisions.push({ action: 'press_key', key: 'Enter' }, placed)
    const { asked, done } = run(page, 'semantic-sandbox-enter', pressContinue, {
      sandboxProfile: true
    })
    await expect(done).resolves.toMatchObject({ ok: true })
    expect(asked).toEqual([])
  })
})
