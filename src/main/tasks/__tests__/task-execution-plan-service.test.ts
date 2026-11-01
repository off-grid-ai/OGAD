/**
 * Task planning. The default generator is the real chat engine owner (`llm`) talking to a fake
 * llama-server executable (harness/fake-llama-engine); telemetry is the real remote-screen
 * session, read back from the model-call log the app writes.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  installFakeLlamaEngine,
  processAlive,
  unusedPort,
  writeGguf,
  type FakeLlamaEngine
} from '../../__tests__/harness/fake-llama-engine'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-task-plan-'))
const previous = { data: process.env.OFFGRID_DATA_DIR, bin: process.env.OFFGRID_BIN_DIR }
process.env.OFFGRID_DATA_DIR = ROOT
process.env.OFFGRID_BIN_DIR = fs.mkdtempSync(path.join(ROOT, 'no-engines-'))

vi.mock('electron', () => ({
  app: { getPath: () => ROOT, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

import { decodeTaskExecutionPlan } from '../../../shared/task-execution-plan'
import {
  createTaskExecutionPlan,
  createTaskPhaseReporter,
  prepareTaskExecutionPlan
} from '../task-execution-plan-service'
import { llm } from '../../llm'
import { importLocalModel, setActiveModel } from '../../models-manager'
import {
  runWithRemoteScreenTaskSession,
  type ComputerUseRunTelemetry
} from '../../actions/remote-screen-session'

let modelId: string
let engine: FakeLlamaEngine | undefined

beforeAll(async () => {
  const model = await importLocalModel(writeGguf(path.join(ROOT, 'fixtures'), 'reasoner.gguf'))
  modelId = model.id!
  expect(await setActiveModel(modelId)).toEqual({ success: true })
})

afterAll(() => {
  llm.stop()
  for (const { pid } of engine?.launches() ?? [])
    if (processAlive(pid)) process.kill(pid, 'SIGKILL')
  fs.rmSync(ROOT, { recursive: true, force: true })
  if (previous.data === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previous.data
  if (previous.bin === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = previous.bin
})

function telemetry(): ComputerUseRunTelemetry {
  return {
    runId: 'run-1',
    actionId: 'action-1',
    task: 'plan',
    startedAt: Date.now(),
    strategy: 'same_as_chat',
    reasoningModel: 'session-reasoner',
    groundingModel: '',
    deciderModel: '',
    axSteps: 0,
    visionSteps: 0,
    actions: 0,
    groundingCalls: 0,
    reasoningCalls: 0,
    deciderCalls: 0,
    modelCallIndex: 0
  }
}

/** The model-call rows the app wrote under reports/, header dropped. */
function modelCallRows(): string[] {
  const file = path.join(ROOT, 'reports', 'computer-use-model-calls.csv')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').slice(1) : []
}

describe('task execution plan service', () => {
  it('asks for distinct web phases with visible, non-repeated outcomes', async () => {
    const plan = await createTaskExecutionPlan({
      goal: 'Find round-trip flights from Seattle to London for September 1 to 8, 2027',
      surface: 'web',
      targetLabel: 'Google Flights',
      generate: async (prompt) => {
        expect(prompt).toContain('web agent')
        expect(prompt).toContain('Starting website: Google Flights')
        expect(prompt).toContain('distinct, non-overlapping outcome')
        expect(prompt).toContain('page state that the web agent can confirm from the visible page')
        expect(prompt).toContain(
          'put each route, date, filter, or other constraint in exactly one setup phase'
        )
        expect(prompt).toContain('Do not repeat those constraints in a later results phase')
        expect(prompt).toContain('Return 1 to 16 outcome-based phases')
        expect(prompt).toContain('Do not add a separate verification, reporting, or summary phase')
        expect(prompt).toContain('Name the visible result that completes the final phase')
        expect(prompt).toContain('Do not use a generic phase')
        return JSON.stringify({
          phases: [
            'Open Google Flights',
            'Set Seattle to London for September 1 to 8, 2027',
            'Show matching round-trip flights'
          ]
        })
      }
    })

    expect(plan.phases.map((phase) => phase.title)).toEqual([
      'Open Google Flights',
      'Set Seattle to London for September 1 to 8, 2027',
      'Show matching round-trip flights'
    ])
  })

  it('persists one computer-use plan before any dynamic task step', async () => {
    const recorded: string[] = []
    const plan = await prepareTaskExecutionPlan(
      {
        goal: 'Send a note in Messages',
        surface: 'computer',
        targetLabel: 'Messages',
        generate: async (prompt) => {
          expect(prompt).toContain('computer-use agent')
          expect(prompt).toContain('Target app: Messages')
          return '{"phases":["Open Messages","Send the note","Verify it was sent"]}'
        }
      },
      (marker) => recorded.push(marker)
    )
    recorded.push('pressed [4] Send')

    expect(decodeTaskExecutionPlan(recorded[0] ?? '')).toEqual(plan)
    expect(recorded[1]).toBe('pressed [4] Send')
  })

  it('reports each phase once and clamps unsafe indexes', () => {
    const phases: string[] = []
    const report = createTaskPhaseReporter(
      {
        version: 1,
        phases: [
          { id: 'phase-1', title: 'Open app' },
          { id: 'phase-2', title: 'Complete work' },
          { id: 'phase-3', title: 'Verify result' }
        ]
      },
      (phase) => phases.push(phase)
    )
    report(-5)
    report(0)
    report(1)
    report(99)
    report(99)
    expect(phases).toEqual(['phase-1', 'phase-2', 'phase-3'])
  })

  it('passes cancellation to planning and does not replace Stop with a fallback plan', async () => {
    const controller = new AbortController()
    const planning = createTaskExecutionPlan({
      goal: 'Stop this Web Use task',
      surface: 'web',
      signal: controller.signal,
      generate: async (_prompt, signal) => {
        expect(signal).toBe(controller.signal)
        controller.abort(new Error('stopped from Chat'))
        signal?.throwIfAborted()
        return '{"phases":["This must not run"]}'
      }
    })

    await expect(planning).rejects.toThrow('stopped from Chat')
  })

  it('uses the active reasoner and records successful default generation', async () => {
    const bin = fs.mkdtempSync(path.join(ROOT, 'bin-'))
    process.env.OFFGRID_BIN_DIR = bin
    engine = installFakeLlamaEngine(bin)
    engine.reply({
      choices: [
        { message: { role: 'assistant', content: '{"phases":["Open Notes","Write the note"]}' } }
      ]
    })
    ;(llm as unknown as { port: number }).port = await unusedPort()
    const run = telemetry()

    const plan = await runWithRemoteScreenTaskSession(
      {
        taskKind: 'computer_use',
        modelStrategy: 'same_as_chat',
        activeServer: null,
        telemetry: run
      },
      () =>
        createTaskExecutionPlan({ goal: 'Write a note', surface: 'computer', targetLabel: 'Notes' })
    )

    expect(plan.phases.map((phase) => phase.title)).toEqual(['Open Notes', 'Write the note'])
    expect(run.reasoningCalls).toBe(1)
    const [row] = modelCallRows()
    expect(row).toContain(',task_plan,ax,reasoning,')
    expect(row).toContain(`,${modelId},completed,`)
    expect(row).toContain('Open Notes')
    llm.stop()
  })

  it('records a reasoner error and returns the safe fallback plan', async () => {
    fs.rmSync(path.join(ROOT, 'reports'), { recursive: true, force: true })
    // No chat engine is installed, so the reasoner cannot answer.
    process.env.OFFGRID_BIN_DIR = fs.mkdtempSync(path.join(ROOT, 'no-engines-'))
    llm.stop()
    const run = telemetry()

    const plan = await runWithRemoteScreenTaskSession(
      { taskKind: 'web_use', modelStrategy: 'same_as_chat', activeServer: null, telemetry: run },
      () => createTaskExecutionPlan({ goal: 'Open settings', surface: 'web' })
    )

    expect(plan.phases.length).toBeGreaterThan(0)
    const [row] = modelCallRows()
    expect(row).toContain(',task_plan,vision,reasoning,')
    expect(row).toContain(',failed,')
    expect(row).toContain('No chat engine is installed')
  })
})
