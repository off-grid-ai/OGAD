#!/usr/bin/env node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import process from 'node:process'
import type { AxElement, AxSnapshot } from '../../src/main/accessibility/ax-elements'
import { chooseFactorizedElementStep } from '../../src/main/accessibility/ax-decision'
import {
  observationStateSignature,
  parseElementStep,
  runElementTask,
  type ElementStep
} from '../../src/main/accessibility/ax-agent'
import { compactWriterPrompt, parseWriterResult } from '../../src/main/accessibility/ax-writer'

const LABELS = 'ABCDEFGHIJ'
const DECISION_PORT = Number(process.env.OFFGRID_OSWORLD_DECISION_PORT ?? 8469)
const REASONER_PORT = Number(process.env.OFFGRID_OSWORLD_REASONER_PORT ?? 8470)
const DEFAULT_MODEL = path.join(
  process.env.HOME ?? '',
  'Library/Application Support/Off Grid AI Desktop/models/decider-2b-q8_0.gguf'
)
const DEFAULT_REASONER = path.join(
  process.env.HOME ?? '',
  'Library/Application Support/Off Grid AI Desktop/models/Qwen3.5-9B-Q4_K_M.gguf'
)

interface BridgeCommand {
  operation: 'reset' | 'observe' | 'close'
  goal?: string
  snapshot?: AxSnapshot
}

interface BridgeResponse {
  ok: boolean
  event?: 'ready' | 'reset' | 'action' | 'terminal'
  action?: string
  summary?: string
  error?: string
  trace?: unknown
}

class AsyncQueue<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(value: T) => void> = []

  push(value: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(value)
    else this.values.push(value)
  }

  shift(): Promise<T> {
    const value = this.values.shift()
    return value === undefined
      ? new Promise<T>((resolve) => this.waiters.push(resolve))
      : Promise.resolve(value)
  }
}

function emit(response: BridgeResponse): void {
  process.stdout.write(`OFFGRID_OSWORLD_JSON:${JSON.stringify(response)}\n`)
}

function optionPrompt(context: string, question: string, options: readonly string[]): string {
  if (options.length < 2 || options.length > LABELS.length) {
    throw new Error('A decision needs between 2 and 10 options.')
  }
  return [
    `Context:\n${context}`,
    `Question: ${question}`,
    'Options:',
    ...options.map((option, index) => `(${LABELS[index]}) ${option}`),
    'Answer: ('
  ].join('\n')
}

function decisionBody(prompt: string, optionCount: number): Record<string, unknown> {
  return {
    prompt,
    n_predict: 1,
    n_probs: 64,
    post_sampling_probs: true,
    temperature: 1.3,
    top_k: 0,
    top_p: 1,
    min_p: 0,
    grammar: `root ::= [${LABELS.slice(0, optionCount)}]`
  }
}

function parseDecision(
  raw: string,
  optionCount: number
): { choice: number; confidence: number; probabilities: number[] } {
  const parsed = JSON.parse(raw) as {
    completion_probabilities?: Array<{
      top_probs?: Array<{ token?: string; prob?: number }>
      top_logprobs?: Array<{ token?: string; prob?: number }>
    }>
  }
  const values = Array.from({ length: optionCount }, () => 0)
  const first = parsed.completion_probabilities?.[0]
  for (const item of first?.top_probs ?? first?.top_logprobs ?? []) {
    const index = LABELS.indexOf(item.token?.trim() ?? '')
    if (index >= 0 && index < optionCount && typeof item.prob === 'number') {
      values[index] = item.prob
    }
  }
  const total = values.reduce((sum, value) => sum + value, 0)
  if (!(total > 0)) throw new Error('The Decision model returned no option probabilities.')
  const probabilities = values.map((value) => value / total)
  const choice = probabilities.reduce(
    (best, value, index) => (value > probabilities[best]! ? index : best),
    0
  )
  return { choice, confidence: probabilities[choice]!, probabilities }
}

function startModelServer(
  modelPath: string,
  port: number,
  contextSize: number
): ChildProcessWithoutNullStreams {
  const binary = path.resolve('resources/bin/llama/llama-server')
  const binaryDirectory = path.dirname(binary)
  const server = spawn(
    binary,
    [
      '--model',
      modelPath,
      '--port',
      String(port),
      '--ctx-size',
      String(contextSize),
      '--parallel',
      '1',
      '--n-gpu-layers',
      '99',
      '--flash-attn',
      'on',
      '--cache-type-k',
      'q8_0',
      '--cache-type-v',
      'q8_0',
      '--batch-size',
      '128'
    ],
    {
      env: {
        ...process.env,
        DYLD_LIBRARY_PATH: [binaryDirectory, process.env.DYLD_LIBRARY_PATH]
          .filter(Boolean)
          .join(':')
      },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  server.stdout.pipe(process.stderr)
  server.stderr.pipe(process.stderr)
  return server
}

async function waitForModelServer(
  server: ChildProcessWithoutNullStreams,
  port: number
): Promise<void> {
  for (;;) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`The model server on port ${port} stopped during startup.`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) return
    } catch {
      // The fixed local model is still loading.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function scoreOptions(
  context: string,
  question: string,
  options: readonly string[]
): Promise<{ choice: number; confidence: number; probabilities: number[] }> {
  const response = await fetch(`http://127.0.0.1:${DECISION_PORT}/completion`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(decisionBody(optionPrompt(context, question, options), options.length))
  })
  if (!response.ok) throw new Error(`Decision request failed with HTTP ${response.status}.`)
  return parseDecision(await response.text(), options.length)
}

async function reasonerRequest(
  messages: Array<{ role: string; content: string }>
): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${REASONER_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages,
      temperature: 0,
      max_tokens: 400,
      chat_template_kwargs: { enable_thinking: false },
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'computer_action',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: {
                type: 'string',
                enum: ['click', 'hover', 'press', 'key', 'give_up']
              },
              index: { type: 'integer' },
              keys: { type: 'string' },
              why: { type: 'string' }
            },
            required: ['action']
          }
        }
      }
    })
  })
  if (!response.ok) throw new Error(`Reasoner request failed with HTTP ${response.status}.`)
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return body.choices?.[0]?.message?.content ?? ''
}

async function writerStep(
  milestone: string,
  snapshot: AxSnapshot,
  targetIndex: number | undefined
): Promise<ElementStep> {
  const field = snapshot.elements.find(
    (element) =>
      element.index === targetIndex &&
      element.enabled &&
      element.executable !== false &&
      /TextField|TextArea|Edit|Document|ComboBox/i.test(element.role)
  )
  if (!field) return { action: 'give_up', why: 'The selected editable field is unavailable.' }
  const input = {
    milestone,
    field: { role: field.role, label: field.name, value: field.value },
    nearbyText: snapshot.elements
      .filter((element) => Math.abs(element.cy - field.cy) < 180)
      .map((element) => element.name || element.value)
      .filter(Boolean),
    guidance: []
  }
  const response = await fetch(`http://127.0.0.1:${REASONER_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: compactWriterPrompt(input) }],
      temperature: 0,
      max_tokens: 400,
      chat_template_kwargs: { enable_thinking: false },
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'computer_use_writer',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              fill: { type: 'boolean' },
              text: { type: 'string' },
              submit: { type: 'boolean' }
            },
            required: ['fill', 'text', 'submit']
          }
        }
      }
    })
  })
  if (!response.ok) throw new Error(`Writer request failed with HTTP ${response.status}.`)
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const writer = parseWriterResult(body.choices?.[0]?.message?.content ?? '', input)
  return writer.fill
    ? {
        action: 'type',
        index: field.index,
        text: writer.text,
        ...(writer.submit ? { submitKeys: 'Enter' } : {})
      }
    : { action: 'give_up', why: writer.refusalReason ?? 'The writer could not produce text.' }
}

function pythonString(value: string): string {
  return JSON.stringify(value)
}

function keysAction(keys: string): string {
  const parts = keys
    .trim()
    .split(/[+\s]+/)
    .filter(Boolean)
    .map((key) => {
      const normalized = key.toLocaleLowerCase()
      if (normalized === 'cmd' || normalized === 'command' || normalized === 'meta') return 'ctrl'
      if (normalized === 'return') return 'enter'
      if (normalized === 'esc') return 'escape'
      return normalized
    })
  if (parts.length === 0) return 'WAIT'
  return parts.length === 1
    ? `import pyautogui\npyautogui.press(${pythonString(parts[0]!)})`
    : `import pyautogui\npyautogui.hotkey(${parts.map(pythonString).join(', ')})`
}

function pointAction(element: AxElement, kind: 'click' | 'hover'): string {
  return kind === 'hover'
    ? `import pyautogui\npyautogui.moveTo(${element.cx}, ${element.cy}, duration=0.2)`
    : `import pyautogui\npyautogui.click(${element.cx}, ${element.cy})`
}

class HarnessSession {
  private readonly observations = new AsyncQueue<AxSnapshot>()
  private readonly responses = new AsyncQueue<BridgeResponse>()
  private current: AxSnapshot | null = null
  private running = true

  constructor(
    private readonly goal: string,
    private readonly maxSteps: number
  ) {
    void this.run()
  }

  async observe(snapshot: AxSnapshot): Promise<BridgeResponse> {
    if (!this.running) return { ok: false, error: 'The harness session is not running.' }
    this.observations.push(snapshot)
    return this.responses.shift()
  }

  stop(): void {
    this.running = false
  }

  private async nextObservation(): Promise<AxSnapshot> {
    if (!this.running) throw new Error('The harness session stopped.')
    this.current = await this.observations.shift()
    return this.current
  }

  private async requestAction(action: string, trace?: unknown): Promise<void> {
    this.responses.push({ ok: true, event: 'action', action, trace })
    await this.nextObservation()
  }

  private async recover(
    summary: string,
    steps: readonly string[]
  ): Promise<{ ok: boolean; detail?: string }> {
    if (!this.current) return { ok: false, detail: 'No current observation is available.' }
    const snapshot = this.current
    const candidates = snapshot.elements
      .filter((element) => element.enabled && element.executable !== false)
      .map(
        (element) =>
          `[${element.index}] ${element.role} ${JSON.stringify(element.name || element.value || 'unnamed')} value=${JSON.stringify(element.value)} focused=${String(element.focused ?? false)}`
      )
      .join('\n')
    const raw = await reasonerRequest([
      {
        role: 'system',
        content:
          'You are the fixed recovery model inside the OGAD computer-use harness. Choose one safe next action from the current structured controls. Follow the user goal. Do not repeat an action that had no effect. Return JSON only.'
      },
      {
        role: 'user',
        content: `Goal: ${this.goal}\nHarness evidence: ${summary}\nRecent steps:\n${steps.slice(-4).join('\n')}\nControls:\n${candidates}`
      }
    ])
    const step = parseElementStep(raw)
    if (!step) return { ok: false, detail: 'The recovery response did not parse.' }
    const before = observationStateSignature(snapshot)
    const action = this.actionForStep(snapshot, step)
    if (!action) return { ok: false, detail: 'The recovery response was not executable.' }
    await this.requestAction(action, { backend: 'reasoner', step })
    const after = this.current ? observationStateSignature(this.current) : before
    return before === after
      ? { ok: false, detail: 'The recovery action did not change the observed state.' }
      : { ok: true }
  }

  private actionForStep(snapshot: AxSnapshot, step: ElementStep): string | null {
    if (step.action === 'key') return keysAction(step.keys)
    if (step.action === 'wait') return `import time\ntime.sleep(${step.durationMs / 1000})`
    if (step.action !== 'click' && step.action !== 'hover' && step.action !== 'press') return null
    const element = snapshot.elements.find((candidate) => candidate.index === step.index)
    return element ? pointAction(element, step.action === 'hover' ? 'hover' : 'click') : null
  }

  private async run(): Promise<void> {
    try {
      const result = await runElementTask(this.goal, {
        read: async () => this.current ?? this.nextObservation(),
        actuator: {
          click: async (element) => this.requestAction(pointAction(element, 'click')),
          hover: async (element) => this.requestAction(pointAction(element, 'hover')),
          press: async (element) => this.requestAction(pointAction(element, 'click')),
          type: async (element, text) => {
            const focus = element
              ? `pyautogui.click(${element.cx}, ${element.cy})\npyautogui.hotkey('ctrl', 'a')\n`
              : ''
            await this.requestAction(
              `import pyautogui\n${focus}pyautogui.write(${pythonString(text)}, interval=0.001)`
            )
          },
          keys: async (keys) => this.requestAction(keysAction(keys))
        },
        decide: async () => JSON.stringify({ action: 'give_up', why: 'No Decider is available.' }),
        decideElement: async (prompt, snapshot) => {
          const decision = await chooseFactorizedElementStep(prompt, snapshot, scoreOptions)
          let step = decision.step
          let backend = decision.result.backend
          if (
            step.action === 'vision_required' &&
            step.why === 'A bounded free-text writer is required.'
          ) {
            step = await writerStep(this.goal, snapshot, decision.writerTargetIndex)
            backend = 'reasoner'
          }
          return JSON.stringify({ ...step, _trace: { ...decision.result, backend } })
        },
        validateAction: async (snapshot, step) => {
          if (
            step.action !== 'click' &&
            step.action !== 'hover' &&
            step.action !== 'press' &&
            step.action !== 'type'
          ) {
            return true
          }
          if (step.index === undefined) return true
          return snapshot.elements.some(
            (element) =>
              element.index === step.index && element.enabled && element.executable !== false
          )
        },
        verifyAction: async (before) => ({
          status:
            this.current &&
            observationStateSignature(before) !== observationStateSignature(this.current)
              ? 'satisfied'
              : 'unknown',
          latencyMs: 0,
          samples: 1
        }),
        recoverWithVision: async (recovery) => this.recover(recovery.summary, recovery.steps),
        waitForUser: async (why) => {
          throw new Error(`OSWorld does not provide human input: ${why}`)
        },
        maxSteps: this.maxSteps
      })
      this.running = false
      this.responses.push({
        ok: true,
        event: 'terminal',
        action: result.ok ? 'DONE' : 'FAIL',
        summary: result.summary,
        trace: { steps: result.steps, recovery: result.recovery }
      })
    } catch (error) {
      this.running = false
      this.responses.push({
        ok: false,
        event: 'terminal',
        action: 'FAIL',
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

async function main(): Promise<void> {
  const modelPath = process.env.OFFGRID_DECISION_MODEL ?? DEFAULT_MODEL
  const reasonerPath = process.env.OFFGRID_REASONER_MODEL ?? DEFAULT_REASONER
  const decisionServer = startModelServer(modelPath, DECISION_PORT, 2_048)
  const reasonerServer = startModelServer(reasonerPath, REASONER_PORT, 8_192)
  let session: HarnessSession | null = null
  const shutdown = (): void => {
    session?.stop()
    decisionServer.kill('SIGTERM')
    reasonerServer.kill('SIGTERM')
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  await Promise.all([
    waitForModelServer(decisionServer, DECISION_PORT),
    waitForModelServer(reasonerServer, REASONER_PORT)
  ])
  emit({
    ok: true,
    event: 'ready',
    trace: { decisionModel: modelPath, reasonerModel: reasonerPath }
  })
  const lines = createInterface({ input: process.stdin })
  for await (const line of lines) {
    try {
      const command = JSON.parse(line) as BridgeCommand
      if (command.operation === 'reset') {
        session?.stop()
        if (!command.goal) throw new Error('reset requires a goal.')
        session = new HarnessSession(
          command.goal,
          Number(process.env.OFFGRID_OSWORLD_HARNESS_STEPS ?? 200)
        )
        emit({ ok: true, event: 'reset' })
      } else if (command.operation === 'observe') {
        if (!session) throw new Error('reset is required before observe.')
        if (!command.snapshot) throw new Error('observe requires a snapshot.')
        emit(await session.observe(command.snapshot))
      } else if (command.operation === 'close') {
        emit({ ok: true })
        break
      } else {
        throw new Error(`Unknown operation: ${String(command.operation)}`)
      }
    } catch (error) {
      emit({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  shutdown()
}

void main().catch((error) => {
  emit({
    ok: false,
    error: error instanceof Error ? (error.stack ?? error.message) : String(error)
  })
  process.exitCode = 1
})
