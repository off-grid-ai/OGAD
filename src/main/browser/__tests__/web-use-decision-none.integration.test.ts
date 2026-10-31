/**
 * Decision + Reasoning: the Decision model may reject every proposed action. Run for real
 * (Qwen 3.5 9B, Kev 4B, UI-Mate 9B through the browser extension) that ended the task at once,
 * while the same models finished it on the run before. The step loop, the policy, the Decision
 * runtime and the chat engine owner are real; the models' replies come from this test through the
 * llama-server executable (harness/fake-llama-engine), and the page is a Playwright boundary.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installFakeLlamaEngine,
  processAlive,
  unusedPort,
  useModelBrain,
  writeGguf,
  type FakeLlamaEngine,
  type ModelBrain
} from '../../__tests__/harness/fake-llama-engine'
import { holdDecisionPorts } from '../../__tests__/harness/decision-port-lock'

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-web-decision-none-'))
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

/** What the Decision model answers for each step: reject every proposal, or take the first. */
const policy = { replies: [] as Array<'none' | 'done'>, notes: [] as string[] }

import { runBrowserPlaywrightTask } from '../browser-playwright-task'
import type { PlaywrightMcpSession, PlaywrightToolResult } from '../playwright-mcp-session'
import type { BrowserDriver } from '../browser-driver'
import { VisionGuard } from '../../vision/vision-guard'
import { llm } from '../../llm'
import { decisionRuntime } from '../../accessibility/decision-runtime'
import { DECIDER_2B, importLocalModel, setActiveModel } from '../../models-manager'
import { setWebUseSettings } from '../../web-use-settings'

function run(taskId: string): ReturnType<typeof runBrowserPlaywrightTask> {
  const session = {
    snapshot: async (): Promise<PlaywrightToolResult> => ({
      text: 'heading "Synthetic Outfitters" [level=1] [ref=e1]',
      isError: false
    }),
    call: async (): Promise<PlaywrightToolResult> => ({ text: 'ok', isError: false }),
    recoverPage: async (): Promise<PlaywrightToolResult> => ({ text: 'ok', isError: false })
  } as unknown as PlaywrightMcpSession
  return runBrowserPlaywrightTask({
    goal: 'Report the main heading',
    plan: { version: 1, phases: [{ id: 'phase-1', title: 'Read the heading' }] },
    session,
    guard: new VisionGuard({ taskId, kind: 'web_use' }),
    activeDriver: () => ({}) as unknown as BrowserDriver,
    activeUrl: () => 'http://127.0.0.1:8090/shop.html',
    waitForUser: async () => undefined,
    takeGuidance: () => [],
    onStep: () => undefined,
    onPhase: () => undefined,
    onProgress: () => undefined
  })
}

const DONE = {
  action: 'done',
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
  evidence_text: 'Synthetic Outfitters',
  reason: '',
  summary: 'Read the heading.'
}

let engine: FakeLlamaEngine
let brain: ModelBrain
let releasePorts: () => void = () => {}

beforeAll(async () => {
  const chat = await importLocalModel(writeGguf(path.join(PROFILE, 'fixtures'), 'chat.gguf'))
  expect(await setActiveModel(chat.id!)).toEqual({ success: true })
  writeGguf(llm.getModelsDir(), DECIDER_2B.files[0]!.name)
  setWebUseSettings({ modelStrategy: 'decision_plus_reasoning', decisionModelId: DECIDER_2B.id })
  const bin = path.join(PROFILE, 'bin')
  process.env.OFFGRID_BIN_DIR = bin
  engine = installFakeLlamaEngine(bin)
  brain = await useModelBrain(engine, (request) => {
    // The Decision model: one proposal (A) and "none of these" (B).
    if (request.path === '/completion') {
      const none = policy.replies.shift() === 'none'
      return {
        json: {
          content: none ? 'B' : 'A',
          completion_probabilities: [
            {
              top_probs: [
                { token: 'A', prob: none ? 0.1 : 0.9 },
                { token: 'B', prob: none ? 0.9 : 0.1 }
              ]
            }
          ]
        }
      }
    }
    // The reasoning model proposes reading the heading; it is told why the last step failed.
    policy.notes.push(/Recovery evidence: (.*)/.exec(request.prompt)?.[1] ?? '')
    return JSON.stringify({ candidates: [DONE] })
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

beforeEach(async () => {
  releasePorts = await holdDecisionPorts()
  policy.replies.length = 0
  policy.notes.length = 0
})

afterEach(async () => {
  await decisionRuntime.shutdown()
  releasePorts()
})

describe('Web Use when the Decision model rejects every proposal', () => {
  it('asks again from a fresh snapshot instead of ending the task', async () => {
    policy.replies.push('none', 'done')
    const result = await run('web-decision-none-retry')
    expect(result.ok).toBe(true)
    expect(policy.notes[1]).toMatch(/rejected every proposed action/)
  })

  it('still stops when it keeps rejecting on an unchanged page', async () => {
    // Five steps without progress, as browser-use stops at five consecutive failures.
    policy.replies.push(...Array.from({ length: 8 }, () => 'none' as const))
    const result = await run('web-decision-none-stuck')
    expect(result.ok).toBe(false)
    expect(policy.notes.length).toBeLessThanOrEqual(5)
  })
})
