/**
 * Which Decision model answers, on which runtime, and how the shared chat engine is borrowed and
 * given back. Everything of ours is real: settings, the model inventory, the dedicated Decision
 * runtime, the chat engine owner, remote model servers and the telemetry log. The boundaries are
 * the executables (llama-server for the Decider and chat, Kev's server; harness/), model files on
 * disk where downloads put them, and remote model servers as local HTTP servers.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installFakeLlamaEngine,
  processAlive,
  unusedPort,
  writeGguf,
  type FakeLlamaEngine
} from '../../__tests__/harness/fake-llama-engine'
import {
  installFakeKevRuntime,
  installKevModel,
  type FakeKevRuntime
} from '../../__tests__/harness/fake-kev-runtime'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-decision-loader-'))
const BIN = path.join(ROOT, 'bin')
const previous = { data: process.env.OFFGRID_DATA_DIR, bin: process.env.OFFGRID_BIN_DIR }
process.env.OFFGRID_DATA_DIR = ROOT
process.env.OFFGRID_BIN_DIR = fs.mkdtempSync(path.join(ROOT, 'no-engines-'))

vi.mock('electron', () => ({
  app: { getPath: () => ROOT, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] }
}))

import {
  decideWithDecisionModel,
  parseRemoteDecision,
  selectedDecisionModelId,
  withDecisionModel,
  withReasoningModel
} from '../decision-model-loader'
import { decisionRuntime } from '../decision-runtime'
import { llm } from '../../llm'
import {
  DECIDER_2B,
  DECIDER_2B_VISION,
  KEV_4B_ID,
  KEV_9B_ID,
  KEV_MODELS,
  importLocalModel,
  setActiveModel
} from '../../models-manager'
import { getComputerUseSettings, setComputerUseSettings } from '../../computer-use-settings'
import { setWebUseSettings } from '../../web-use-settings'
import {
  runWithRemoteScreenTaskSession,
  type ComputerUseRunTelemetry
} from '../../actions/remote-screen-session'
import { unloadModelRole } from '../../model-memory'
import { setRemoteVisionServerSettings } from '../../vision/remote-vision-server'
import { remoteVisionModelId } from '../../../shared/remote-vision-server'

const SELECTED = DECIDER_2B_VISION
let chatId: string
let engine: FakeLlamaEngine
let kev: FakeKevRuntime

const modelsDir = (): string => llm.getModelsDir()

/** A catalog model's files, where its download puts them. */
function install(model: { files: readonly { name: string }[] }): void {
  for (const file of model.files) {
    const target = path.join(modelsDir(), file.name)
    writeGguf(path.dirname(target), path.basename(target))
  }
}

/** A Kev model: its catalog files and the checkpoint and base the server reads. */
function installKev(modelId: string): void {
  install(KEV_MODELS.find((model) => model.id === modelId)!)
  installKevModel(modelsDir(), modelId)
}

/** llama-server's /completion body for one forced token with these option probabilities. */
const tokenProbabilities = (probs: Record<string, number>): Record<string, unknown> => ({
  content: 'A',
  completion_probabilities: [
    { top_probs: Object.entries(probs).map(([token, prob]) => ({ token, prob })) }
  ]
})

function telemetry(): ComputerUseRunTelemetry {
  return {
    runId: 'run',
    actionId: 'action',
    task: 'decide',
    startedAt: Date.now(),
    strategy: 'decision_plus_specialist',
    reasoningModel: '',
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

/** Run `task` inside a task session of this kind, as a running task does. */
function inTask<T>(
  taskKind: 'web_use' | 'computer_use',
  task: () => Promise<T>,
  run = telemetry()
): Promise<T> {
  return runWithRemoteScreenTaskSession(
    { taskKind, modelStrategy: 'decision_plus_specialist', activeServer: null, telemetry: run },
    task
  )
}

/** The model-call rows the app wrote under reports/, header dropped. */
function modelCallRows(): string[] {
  const file = path.join(ROOT, 'reports', 'computer-use-model-calls.csv')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').slice(1) : []
}

/** Decider launches of the shared llama-server binary: they carry the Decider's batch size. */
const deciderLaunches = (): ReturnType<FakeLlamaEngine['launches']> =>
  engine.launches().filter((launch) => launch.args.join(' ').includes('-b 128'))
const chatLaunches = (): ReturnType<FakeLlamaEngine['launches']> =>
  engine.launches().filter((launch) => !launch.args.join(' ').includes('-b 128'))

beforeAll(async () => {
  const chat = await importLocalModel(writeGguf(path.join(ROOT, 'fixtures'), 'chat.gguf'))
  chatId = chat.id!
  expect(await setActiveModel(chatId)).toEqual({ success: true })
})

beforeEach(async () => {
  fs.rmSync(BIN, { recursive: true, force: true })
  fs.rmSync(path.join(ROOT, 'reports'), { recursive: true, force: true })
  process.env.OFFGRID_BIN_DIR = BIN
  engine = installFakeLlamaEngine(BIN)
  kev = installFakeKevRuntime(BIN)
  engine.reply(tokenProbabilities({ A: 1, B: 0 }))
  kev.reply({
    answers: { decision: { choice: 'option_0', probabilities: { option_0: 1, option_1: 0 } } }
  })
  ;(llm as unknown as { port: number }).port = await unusedPort()
  install(SELECTED)
  setComputerUseSettings({
    ...getComputerUseSettings(),
    decisionModelId: SELECTED.id,
    modelStrategy: 'decision_plus_specialist'
  })
  setWebUseSettings({ decisionModelId: KEV_4B_ID })
})

afterEach(async () => {
  await decisionRuntime.shutdown()
  // Back to the saved chat model, as the end of a task returns it.
  llm.restoreSelectedModel()
  llm.stop()
  for (const { pid } of [...engine.launches(), ...kev.starts()])
    if (processAlive(pid)) process.kill(pid, 'SIGKILL')
})

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
  if (previous.data === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previous.data
  if (previous.bin === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = previous.bin
})

describe('decision model lifecycle', () => {
  it('uses Web Use Kev for loading and decisions, not the Computer Use model', async () => {
    installKev(KEV_4B_ID)
    await inTask('web_use', async () => {
      expect(selectedDecisionModelId()).toBe(KEV_4B_ID)
      await withDecisionModel(() => decideWithDecisionModel('page', 'next?', ['A', 'B']))
    })
    expect(kev.starts()[0]?.args[2]).toContain(path.join(modelsDir(), 'kev-4b'))
    expect(modelCallRows()[0]).toContain(`,decider,${KEV_4B_ID},completed,`)
    // The shared chat engine was never handed the Decision model.
    expect(engine.launches()).toEqual([])
    expect(llm.activeModelInfo()?.id).toBe(chatId)
  })

  it('runs a selected Kev 9B on its own runtime, without the shared fallback', async () => {
    installKev(KEV_9B_ID)
    setComputerUseSettings({ ...getComputerUseSettings(), decisionModelId: KEV_9B_ID })
    await withDecisionModel(() => decideWithDecisionModel('page', 'next?', ['A', 'B']))
    expect(kev.starts()[0]?.args[2]).toContain(path.join(modelsDir(), 'kev-9b'))

    kev.outOfMemory(true)
    await expect(withDecisionModel(async () => 'never')).rejects.toMatchObject({
      code: 'out_of_memory'
    })
    expect(engine.launches()).toEqual([])
    expect(llm.activeModelInfo()?.id).toBe(chatId)
  })

  it('does not inherit the Computer Use selection when Web Use has no selection', async () => {
    setWebUseSettings({ decisionModelId: null })
    await inTask('web_use', async () => expect(selectedDecisionModelId()).toBe(DECIDER_2B.id))
    await inTask('computer_use', async () => expect(selectedDecisionModelId()).toBe(SELECTED.id))
  })

  it('selects the configured model and requires it to be installed', async () => {
    expect(selectedDecisionModelId()).toBe(SELECTED.id)
    setComputerUseSettings({ ...getComputerUseSettings(), decisionModelId: null })
    expect(selectedDecisionModelId()).toBe(DECIDER_2B.id)

    setComputerUseSettings({ ...getComputerUseSettings(), decisionModelId: SELECTED.id })
    for (const file of SELECTED.files) fs.rmSync(path.join(modelsDir(), file.name))
    await expect(withDecisionModel(async () => 'never')).rejects.toThrow(
      `The selected Decision model is not downloaded: ${SELECTED.name}.`
    )
  })

  it('keeps one dedicated runtime for nested decisions and shuts it down afterward', async () => {
    const run = telemetry()
    const result = await inTask(
      'computer_use',
      () =>
        withDecisionModel(async () => {
          const nested = await withDecisionModel(async () => 'nested')
          expect(nested).toBe('nested')
          return decideWithDecisionModel('state', 'next?', ['A', 'B'])
        }),
      run
    )

    expect(result.choice).toBe(0)
    expect(deciderLaunches()).toHaveLength(1)
    // Decision models are on-demand: the runtime is gone once the phase ends.
    expect(processAlive(deciderLaunches()[0]!.pid)).toBe(false)
    expect(decisionRuntime.running).toBe(false)
    expect(run.deciderCalls).toBe(1)
    expect(modelCallRows()[0]).toContain(',structured_option_selection,ax,decider,')
  })

  it('restarts a stopped dedicated runtime once before a decision', async () => {
    await withDecisionModel(async () => {
      process.kill(deciderLaunches()[0]!.pid, 'SIGKILL')
      await vi.waitFor(() => expect(decisionRuntime.running).toBe(false))
      await expect(decideWithDecisionModel('state', 'next?', ['A', 'B'])).resolves.toMatchObject({
        choice: 0
      })
    })
    expect(deciderLaunches()).toHaveLength(2)
  })

  it('does not count deliberate memory swaps as crashes', async () => {
    await withDecisionModel(async () => {
      for (let i = 0; i < 3; i++) {
        // Unload, as another model's admission or the Unload button does.
        await unloadModelRole('decision')
        await decideWithDecisionModel('state', 'next?', ['A', 'B'])
      }
    })
    expect(deciderLaunches()).toHaveLength(4)
  })

  it('uses the explicit shared-model fallback after local memory pressure', async () => {
    engine.reply(tokenProbabilities({ A: 0, B: 1 }))
    await llm.init()
    // The dedicated Decider cannot fit; the shared chat engine can take the Decision model.
    engine.outOfMemory('llama', '-b 128')

    const result = await withDecisionModel(() =>
      decideWithDecisionModel('state', 'next?', ['A', 'B'])
    )

    expect(result.choice).toBe(1)
    const shared = chatLaunches().map((launch) => launch.args[launch.args.indexOf('-m') + 1])
    // Chat, then the Decision model in the shared engine, then chat again.
    expect(shared).toHaveLength(3)
    expect(path.basename(shared[1]!)).toBe(SELECTED.files[0]!.name)
    expect(path.basename(shared[2]!)).toBe('chat.gguf')
    expect(llm.activeModelInfo()?.id).toBe(chatId)
  })

  it('does not use the shared fallback for Kev or ordinary startup errors', async () => {
    installKev(KEV_4B_ID)
    setComputerUseSettings({ ...getComputerUseSettings(), decisionModelId: KEV_4B_ID })
    kev.outOfMemory(true)
    await expect(withDecisionModel(async () => 'never')).rejects.toMatchObject({
      code: 'out_of_memory'
    })

    // The Decider's engine is missing: a startup error, not memory pressure.
    setComputerUseSettings({ ...getComputerUseSettings(), decisionModelId: SELECTED.id })
    fs.rmSync(path.join(BIN, 'llama'), { recursive: true, force: true })
    await expect(withDecisionModel(async () => 'never')).rejects.toMatchObject({ code: 'startup' })
    expect(llm.activeModelInfo()?.id).toBe(chatId)
  })
})

/** A remote model server: answers each chat or Decisions request with the next queued reply, and
 *  anything else (a llama.cpp-only probe) with 404, as a plain OpenAI-compatible server does. */
async function remoteServer(
  replies: Array<{ status: number; body: unknown }>
): Promise<{ endpoint: string; paths: string[]; close(): Promise<void> }> {
  const paths: string[] = []
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !/chat\/completions|decision/i.test(req.url ?? '')) {
      res.writeHead(404).end()
      return
    }
    paths.push(req.url ?? '')
    let request = ''
    req.on('data', (chunk) => (request += chunk))
    req.on('end', () => {
      const next = replies.shift() ?? { status: 500, body: { error: 'no reply queued' } }
      const stream = (JSON.parse(request) as { stream?: boolean }).stream === true
      const content = (next.body as { choices?: Array<{ message: { content: string } }> })
        .choices?.[0]?.message.content
      if (next.status === 200 && stream && content !== undefined) {
        // An OpenAI-compatible stream: one content delta, then [DONE].
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
        res.end('data: [DONE]\n\n')
        return
      }
      res.writeHead(next.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(next.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    paths,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

describe('decision transports', () => {
  it('parses labels, strips reasoning, normalizes probabilities, and rejects bad choices', () => {
    expect(
      parseRemoteDecision(
        '<think>hidden</think>```json\n{"choice":"B","probabilities":[1,3]}\n```',
        2
      )
    ).toEqual({ choice: 1, confidence: 0.75, probabilities: [0.25, 0.75] })
    expect(parseRemoteDecision('{"choice":0,"probabilities":[-1,"bad"]}', 2)).toEqual({
      choice: 0,
      confidence: 1,
      probabilities: [1, 0]
    })
    expect(() => parseRemoteDecision('{"choice":9}', 2)).toThrow('invalid choice')
  })

  it('uses a remote chat endpoint and records failed model calls', async () => {
    const remote = await remoteServer([
      {
        status: 200,
        body: { choices: [{ message: { content: '{"choice":1,"probabilities":[1,3]}' } }] }
      },
      { status: 503, body: { error: { message: 'remote stopped' } } }
    ])
    try {
      setRemoteVisionServerSettings({
        provider: 'custom',
        endpoint: remote.endpoint,
        model: '',
        roleModels: { decision: 'remote/model' },
        serverId: 'remote-decider',
        name: 'Remote decider'
      })
      const id = remoteVisionModelId('remote-decider', 'remote/model')
      setComputerUseSettings({ ...getComputerUseSettings(), decisionModelId: id })

      await expect(
        inTask('computer_use', () => decideWithDecisionModel('state', 'next?', ['A', 'B']))
      ).resolves.toEqual({ choice: 1, confidence: 0.75, probabilities: [0.25, 0.75] })
      expect(remote.paths).toEqual(['/v1/chat/completions'])

      await expect(
        inTask('computer_use', () => decideWithDecisionModel('state', 'next?', ['A', 'B']))
      ).rejects.toThrow()
      expect(modelCallRows().at(-1)).toContain(',failed,')
    } finally {
      await remote.close()
    }
  })

  it('uses the provider-specific remote decision transport when advertised', async () => {
    const remote = await remoteServer([
      {
        status: 200,
        body: {
          answers: {
            decision: {
              type: 'choice',
              choice: 'option_0',
              probabilities: { option_0: 1, option_1: 0 }
            }
          }
        }
      }
    ])
    try {
      setRemoteVisionServerSettings({
        provider: 'openrouter',
        endpoint: remote.endpoint,
        model: '',
        roleModels: { decision: 'jev' },
        modelCatalog: [{ id: 'jev', name: 'Jev', kind: 'text', outputModalities: ['decisions'] }],
        serverId: 'openrouter-decider',
        name: 'OpenRouter'
      })
      setComputerUseSettings({
        ...getComputerUseSettings(),
        decisionModelId: remoteVisionModelId('openrouter-decider', 'jev')
      })

      await expect(decideWithDecisionModel('state', 'next?', ['A', 'B'])).resolves.toMatchObject({
        choice: 0
      })
      // The Decisions endpoint, not chat completions.
      expect(remote.paths).toHaveLength(1)
      expect(remote.paths[0]).not.toContain('chat/completions')
    } finally {
      await remote.close()
    }
  })
})

describe('reasoning model restoration', () => {
  it('swaps back to reasoning and restores the decision model', async () => {
    // The shared engine holds the Decision model (the swap fallback is in use).
    expect(await setActiveModel(chatId)).toEqual({ success: true })
    const { loadComputerUseModel } = await import('../../models-manager')
    expect(await loadComputerUseModel(SELECTED.id)).toEqual({ success: true })
    await llm.restart()

    await expect(withReasoningModel(async () => llm.activeModelInfo()?.id)).resolves.toBe(chatId)
    expect(llm.activeModelInfo()?.id).toBe(SELECTED.id)
    const loaded = chatLaunches().map((launch) =>
      path.basename(launch.args[launch.args.indexOf('-m') + 1]!)
    )
    expect(loaded).toEqual([SELECTED.files[0]!.name, 'chat.gguf', SELECTED.files[0]!.name])
  })

  it('runs directly when the dedicated runtime or chat model is active', async () => {
    await withDecisionModel(async () => {
      expect(decisionRuntime.running).toBe(true)
      await expect(withReasoningModel(async () => 'dedicated')).resolves.toBe('dedicated')
    })
    await expect(withReasoningModel(async () => 'chat')).resolves.toBe('chat')
    expect(chatLaunches()).toEqual([])
  })
})
