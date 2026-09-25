#!/usr/bin/env node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import type { AxElement, AxSnapshot } from '../src/main/accessibility/ax-elements'
import { chooseFactorizedElementStep } from '../src/main/accessibility/ax-decision'
import {
  observationStateSignature,
  parseElementStep,
  runElementTask,
  type ElementStep
} from '../src/main/accessibility/ax-agent'
import { compactWriterPrompt, parseWriterResult } from '../src/main/accessibility/ax-writer'

const IMAGE = 'ghcr.io/huggingface/openenv-browsergym-env:latest'
const LABELS = 'ABCDEFGHIJ'
const DECISION_PORT = 8469
const REASONER_PORT = 8470
const DEFAULT_MODEL = path.join(
  process.env.HOME ?? '',
  'Library/Application Support/Off Grid AI Desktop/models/decider-2b-q8_0.gguf'
)
const DEFAULT_REASONER = path.join(
  process.env.HOME ?? '',
  'Library/Application Support/Off Grid AI Desktop/models/Qwen3.5-9B-Q4_K_M.gguf'
)

interface WorkerObservation {
  goal: string
  url: string
  axtree: {
    nodes?: Array<{
      nodeId?: string
      parentId?: string
      childIds?: string[]
      browsergym_id?: string
      ignored?: boolean
      role?: { value?: string }
      name?: { value?: string }
      value?: { value?: unknown }
      properties?: Array<{ name?: string; value?: { value?: unknown } }>
    }>
  }
  elements: Record<
    string,
    { visibility?: number; bbox?: [number, number, number, number] | null; clickable?: boolean }
  >
  focusedElementId: string
  lastAction: string
  lastActionError: string
}

interface WorkerResponse {
  ok: boolean
  error?: string
  observation?: WorkerObservation
  reward?: number
  done?: boolean
  terminated?: boolean
  truncated?: boolean
}

interface RunResult {
  task: string
  seed: number
  success: boolean
  reward: number
  steps: number
  outcome: string
  totalMs: number
  decisions: Array<{
    step: number
    action: string
    confidence: number
    margin: number
    entropy: number
    distributions: Array<{ labels: string[]; probabilities: number[] }>
    abstentionReason?: string
    decisionMs: number
    backend: string
  }>
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
): {
  choice: number
  confidence: number
  probabilities: number[]
} {
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
  return spawn(
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
}

async function waitForModelServer(
  server: ChildProcessWithoutNullStreams,
  port: number
): Promise<void> {
  for (;;) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error('The Decision server stopped during startup.')
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) return
    } catch {
      // The local model is still loading.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function reasonerStep(context: string, snapshot: AxSnapshot): Promise<ElementStep | null> {
  const observationItems = snapshot.elements
    .filter((element) => element.enabled)
    .map(
      (element) =>
        `[${element.index}] ${element.role} ${JSON.stringify(element.name || element.value || 'unnamed')} ` +
        `value=${JSON.stringify(element.value)} checked=${String(element.checked ?? 'unknown')} selected=${String(element.selected ?? 'unknown')} focused=${String(element.focused ?? false)} ${element.executable === false ? 'evidence-only' : 'executable'}`
    )
    .join('\n')
  const response = await fetch(`http://127.0.0.1:${REASONER_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [
        {
          role: 'system',
          content:
            'You are the local recovery reasoner for a computer-use harness. Choose one safe next action from the current structured observation. Follow the exact user goal and prior result, including ordinal and spatial relationships. Use evidence-only items to reason, but never act on them. Prefer a named executable control over keyboard navigation. Do not repeat an action that already completed its part of the goal. Return JSON only.'
        },
        {
          role: 'user',
          content: `${context}\nCurrent structured observation:\n${observationItems}\nReturn one action using only an executable item: {"action":"click","index":N}, {"action":"press","index":N}, {"action":"key","keys":"Enter"}, or {"action":"give_up","why":"..."}.`
        }
      ],
      temperature: 1,
      top_p: 0.95,
      top_k: 20,
      min_p: 0,
      presence_penalty: 0,
      repeat_penalty: 1,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'computer_action',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['click', 'hover', 'press', 'key', 'give_up'] },
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
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return parseElementStep(body.choices?.[0]?.message?.content ?? '')
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
  if (!field) {
    return { action: 'human_required', why: 'The selected editable field is no longer available.' }
  }
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
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const writer = parseWriterResult(body.choices?.[0]?.message?.content ?? '', input)
  return writer.fill
    ? {
        action: 'type',
        index: field.index,
        text: writer.text,
        ...(writer.submit ? { submitKeys: 'Enter' } : {})
      }
    : {
        action: 'human_required',
        why:
          writer.refusalReason === 'private_field'
            ? 'The field needs private input.'
            : 'The writer could not produce safe text.'
      }
}

function workerProcess(): {
  process: ChildProcessWithoutNullStreams
  request: (payload: Record<string, unknown>) => Promise<WorkerResponse>
} {
  const workerPath = path.resolve('scripts/browsergym-worker.py')
  const name = `offgrid-browsergym-${process.pid}`
  const child = spawn(
    'docker',
    [
      'run',
      '--rm',
      '-i',
      '--name',
      name,
      '--volume',
      `${workerPath}:/opt/offgrid/browsergym-worker.py:ro`,
      IMAGE,
      'python',
      '/opt/offgrid/browsergym-worker.py'
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  )
  child.stderr.pipe(process.stderr)
  const pending: Array<{
    resolve: (value: WorkerResponse) => void
    reject: (reason: Error) => void
  }> = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.startsWith('OFFGRID_JSON:')) return
    const next = pending.shift()
    if (!next) return
    try {
      next.resolve(JSON.parse(line.slice('OFFGRID_JSON:'.length)) as WorkerResponse)
    } catch (error) {
      next.reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
  child.once('close', (code) => {
    const error = new Error(`BrowserGym worker stopped with code ${code ?? 'unknown'}.`)
    for (const request of pending.splice(0)) request.reject(error)
  })
  return {
    process: child,
    request: (payload) =>
      new Promise<WorkerResponse>((resolve, reject) => {
        pending.push({ resolve, reject })
        child.stdin.write(`${JSON.stringify(payload)}\n`)
      })
  }
}

function roleName(role: string): string {
  const names: Record<string, string> = {
    button: 'AXButton',
    link: 'AXLink',
    checkbox: 'AXCheckBox',
    radio: 'AXRadioButton',
    textbox: 'AXTextField',
    searchbox: 'AXSearchField',
    combobox: 'AXComboBox',
    menuitem: 'AXMenuItem',
    tab: 'AXTab'
  }
  return names[role.toLocaleLowerCase()] ?? `AX${role || 'Unknown'}`
}

function ariaBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

function snapshotFromObservation(observation: WorkerObservation, revision: number): AxSnapshot {
  const elements: AxElement[] = []
  const nodes = observation.axtree.nodes ?? []
  const nodesById = new Map(nodes.flatMap((node) => (node.nodeId ? [[node.nodeId, node]] : [])))
  const descendantText = (
    node: (typeof nodes)[number],
    depth = 0,
    visited = new Set<string>()
  ): string => {
    if (depth > 4) return ''
    const text: string[] = []
    for (const childId of node.childIds ?? []) {
      if (visited.has(childId)) continue
      visited.add(childId)
      const child = nodesById.get(childId)
      if (!child) continue
      const name = child.name?.value?.trim()
      if (name && /StaticText|LabelText/i.test(child.role?.value ?? '')) text.push(name)
      const nested = descendantText(child, depth + 1, visited)
      if (nested) text.push(nested)
    }
    return [...new Set(text)].join(' ').replace(/\s+/g, ' ').trim()
  }
  const hasNestedSemanticMatch = (
    node: (typeof nodes)[number],
    label: string,
    depth = 0,
    visited = new Set<string>()
  ): boolean => {
    if (depth > 4) return false
    const normalized = label.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
    for (const childId of node.childIds ?? []) {
      if (visited.has(childId)) continue
      visited.add(childId)
      const child = nodesById.get(childId)
      if (!child) continue
      const childRole = child.role?.value ?? ''
      const childLabel = (child.name?.value?.trim() || descendantText(child))
        .replace(/\s+/g, ' ')
        .trim()
        .toLocaleLowerCase()
      if (/^(?:button|link|checkbox|radio|menuitem|tab|option)$/i.test(childRole)) {
        if (childLabel && childLabel === normalized) return true
      }
      if (hasNestedSemanticMatch(child, label, depth + 1, visited)) return true
    }
    return false
  }
  for (const node of nodes) {
    const browserId = node.browsergym_id
    if (!browserId || node.ignored) continue
    const geometry = observation.elements[browserId]
    const bounds = geometry?.bbox
    const role = node.role?.value ?? ''
    if (!bounds || (geometry?.visibility ?? 0) <= 0) continue
    const [x, y, width, height] = bounds
    if (width < 3 || height < 3) continue
    const properties = new Map(
      (node.properties ?? []).map((property) => [property.name ?? '', property.value?.value])
    )
    const editable = /textbox|searchbox|combobox/i.test(role)
    const semanticAction = /^(?:button|link|checkbox|radio|menuitem|tab|option)$/i.test(role)
    // BrowserGym marks the label wrapper and its nested form control as
    // clickable. Native AX/UIA exposes the semantic control as the executable
    // target. Keep the fake contract-faithful by dropping only presentation
    // wrappers, while preserving generic and icon-only actionable controls.
    const presentational = /^(?:LabelText|StaticText|InlineTextBox|LineBreak)$/i.test(role)
    const structural = /^(?:Group|List|Menu|TabList|TabPanel|Tree)$/i.test(role)
    const name = node.name?.value?.trim() || descendantText(node)
    const duplicateWrapper = Boolean(name) && hasNestedSemanticMatch(node, name)
    const executable =
      !presentational &&
      !structural &&
      !duplicateWrapper &&
      (geometry?.clickable === true || editable || semanticAction)
    const value =
      typeof node.value?.value === 'string'
        ? node.value.value
        : typeof properties.get('value') === 'string'
          ? String(properties.get('value'))
          : ''
    // Keep visible semantic content as evidence for planning, but never expose
    // it as an action target. BrowserGym supplies table cells, result text, and
    // instructions through the same AX tree as executable controls.
    if (!executable && !name && !value) continue
    const hasPopup = Boolean(properties.get('hasPopup')) && properties.get('hasPopup') !== 'false'
    elements.push({
      index: elements.length + 1,
      role: roleName(role),
      name,
      value,
      cx: Math.round(x + width / 2),
      cy: Math.round(y + height / 2),
      x,
      y,
      width,
      height,
      stableId: browserId,
      source: 'ax',
      processId: 1,
      windowId: observation.url,
      revision,
      checked: ariaBoolean(properties.get('checked')),
      selected: ariaBoolean(properties.get('selected')),
      hasPopup,
      focused: browserId === observation.focusedElementId,
      executable,
      actionable: geometry?.clickable === true || semanticAction,
      enabled: properties.get('disabled') !== true
    })
  }
  return {
    windowTitle: observation.url,
    elements,
    processId: 1,
    processName: 'BrowserGym',
    windowId: observation.url,
    windowBounds: { x: 0, y: 0, width: 1280, height: 720 },
    revision
  }
}

function browserAction(snapshot: AxSnapshot, step: ElementStep): string | null {
  if (step.action === 'click' || step.action === 'hover' || step.action === 'press') {
    const browserId = snapshot.elements.find(
      (element) => element.index === step.index && element.enabled && element.executable !== false
    )?.stableId
    return browserId ? `${step.action === 'hover' ? 'hover' : 'click'}('${browserId}')` : null
  }
  if (step.action === 'type') {
    const browserId = snapshot.elements.find((element) => element.index === step.index)?.stableId
    return browserId
      ? `fill(${JSON.stringify(browserId)}, ${JSON.stringify(step.text)})`
      : `send_keys(${JSON.stringify(step.text)})`
  }
  if (step.action === 'key') return `send_keys('${step.keys}')`
  if (step.action === 'wait') return 'noop()'
  return null
}

async function runTask(input: {
  task: string
  seed: number
  maxSteps?: number
  request: (payload: Record<string, unknown>) => Promise<WorkerResponse>
}): Promise<RunResult> {
  const startedAt = performance.now()
  const reset = await input.request({ operation: 'reset', task: input.task, seed: input.seed })
  if (!reset.ok || !reset.observation) {
    throw new Error(reset.error ?? 'BrowserGym reset failed.')
  }
  let observation = reset.observation
  let reward = 0
  let terminal = false
  let truncated = false
  let revision = 0
  let planningStep = 0
  const decisions: RunResult['decisions'] = []
  let outcome = 'not_completed'

  const currentSnapshot = (): AxSnapshot => snapshotFromObservation(observation, ++revision)
  const context = (): string =>
    [
      `Current goal: ${observation.goal}`,
      `Target application/window: BrowserGym ${observation.url}`,
      observation.lastAction ? `Previous action: ${observation.lastAction}` : '',
      observation.lastActionError ? `Previous action error: ${observation.lastActionError}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  const applyAction = async (action: string): Promise<void> => {
    const result = await input.request({ operation: 'step', action })
    if (!result.ok || !result.observation) {
      throw new Error(result.error ?? 'BrowserGym step failed.')
    }
    observation = result.observation
    reward = result.reward ?? 0
    terminal = result.done === true
    truncated = result.truncated === true
  }
  const actElement = async (element: AxElement): Promise<void> => {
    if (!element.stableId) throw new Error('The BrowserGym element has no stable identifier.')
    await applyAction(`click(${JSON.stringify(element.stableId)})`)
  }

  try {
    const harnessResult = await runElementTask(observation.goal, {
      read: async () => {
        if (terminal) throw new Error('OFFGRID_BROWSERGYM_EPISODE_ENDED')
        return currentSnapshot()
      },
      actuator: {
        click: actElement,
        hover: async (element) => {
          if (!element.stableId) {
            throw new Error('The BrowserGym element has no stable identifier.')
          }
          await applyAction(`hover(${JSON.stringify(element.stableId)})`)
        },
        press: actElement,
        type: async (element, text) => {
          if (element?.stableId) {
            await applyAction(`fill(${JSON.stringify(element.stableId)}, ${JSON.stringify(text)})`)
            return
          }
          await applyAction(`send_keys(${JSON.stringify(text)})`)
        },
        keys: async (keys) => applyAction(`send_keys(${JSON.stringify(keys)})`)
      },
      decide: async () => JSON.stringify({ action: 'give_up', why: 'No Decider is available.' }),
      decideElement: async (prompt, snapshot) => {
        planningStep += 1
        const decisionStartedAt = performance.now()
        const decision = await chooseFactorizedElementStep(
          prompt,
          snapshot,
          async (ctx, question, options) => {
            const response = await fetch(`http://127.0.0.1:${DECISION_PORT}/completion`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(
                decisionBody(optionPrompt(ctx, question, options), options.length)
              )
            })
            if (!response.ok) {
              throw new Error(`Decision request failed with HTTP ${response.status}.`)
            }
            return parseDecision(await response.text(), options.length)
          }
        )
        let step = decision.step
        let backend = decision.result.backend
        if (
          step.action === 'vision_required' &&
          step.why === 'A bounded free-text writer is required.'
        ) {
          step = await writerStep(observation.goal, snapshot, decision.writerTargetIndex)
          backend = 'reasoner'
        }
        const trace = {
          step: planningStep,
          action: browserAction(snapshot, step) ?? JSON.stringify(step),
          confidence: decision.result.combinedConfidence,
          margin: decision.result.probabilityMargin,
          entropy: decision.result.entropy,
          distributions: decision.result.distributions,
          ...(decision.result.abstentionReason
              ? { abstentionReason: decision.result.abstentionReason }
              : {}),
          decisionMs: Number((performance.now() - decisionStartedAt).toFixed(1)),
          backend
        }
        decisions.push(trace)
        process.stderr.write(
          `[decision] task=${input.task} seed=${input.seed} step=${trace.step} action=${trace.action} confidence=${trace.confidence.toFixed(3)} margin=${trace.margin.toFixed(3)} backend=${trace.backend}${trace.abstentionReason ? ` abstention=${trace.abstentionReason}` : ''}\n`
        )
        return JSON.stringify(step)
      },
      validateAction: async (snapshot, step) => {
        if (terminal || snapshot.windowId !== observation.url) return false
        if (
          step.action !== 'click' &&
          step.action !== 'hover' &&
          step.action !== 'press' &&
          step.action !== 'type'
        ) {
          return true
        }
        if (step.index === undefined) return true
        const target = snapshot.elements.find((element) => element.index === step.index)
        return Boolean(
          target?.stableId &&
          currentSnapshot().elements.some((element) => element.stableId === target.stableId)
        )
      },
      verifyAction: async (before) => {
        if (terminal) {
          return {
            status: reward > 0 ? 'satisfied' : 'unsatisfied',
            latencyMs: 0,
            samples: 1
          }
        }
        if (observation.lastActionError) {
          return { status: 'unknown', latencyMs: 0, samples: 1 }
        }
        const changed =
          observationStateSignature(before) !== observationStateSignature(currentSnapshot())
        return {
          status: changed ? 'satisfied' : 'unknown',
          latencyMs: 0,
          samples: 1
        }
      },
      recoverWithVision: async (recovery) => {
        if (terminal) return { ok: false, detail: 'The benchmark episode ended.' }
        const snapshot = currentSnapshot()
        const recoveryStartedAt = performance.now()
        const recovered = await reasonerStep(
          `${context()}\nHarness evidence: ${recovery.summary}\nRecent steps:\n${recovery.steps.slice(-4).join('\n')}`,
          snapshot
        )
        const decisionMs = performance.now() - recoveryStartedAt
        const action = recovered ? browserAction(snapshot, recovered) : null
        decisions.push({
          step: ++planningStep,
          action: action ?? recovered?.action ?? 'invalid_recovery',
          confidence: 0,
          margin: 0,
          entropy: 0,
          distributions: [],
          decisionMs: Number(decisionMs.toFixed(1)),
          backend: 'reasoner'
        })
        process.stderr.write(
          `[decision] task=${input.task} seed=${input.seed} step=${planningStep} action=${action ?? recovered?.action ?? 'invalid_recovery'} confidence=0.000 margin=0.000 backend=reasoner\n`
        )
        if (!action) return { ok: false, detail: 'The reasoner returned no executable action.' }
        const beforeKey = observationStateSignature(snapshot)
        await applyAction(action)
        if (terminal)
          return { ok: reward > 0, detail: reward > 0 ? undefined : 'The episode failed.' }
        const afterKey = observationStateSignature(currentSnapshot())
        return beforeKey === afterKey
          ? { ok: false, detail: 'The recovery action did not change the observed state.' }
          : { ok: true }
      },
      waitForUser: async (why) => {
        throw new Error(`Benchmark requires user input: ${why}`)
      },
      ...(process.env.OFFGRID_BENCHMARK_TRACE === '1'
        ? {
            onObservation: (entry) => {
              process.stderr.write(`[observation] ${JSON.stringify(entry)}\n`)
            }
          }
        : {}),
      ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps })
    })
    outcome = harnessResult.ok ? 'harness_completed' : harnessResult.summary
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Benchmark requires user input:')) {
      outcome = 'human_required'
    } else if (
      !(error instanceof Error) ||
      error.message !== 'OFFGRID_BROWSERGYM_EPISODE_ENDED'
    ) {
      throw error
    }
  }
  if (terminal) {
    outcome = reward > 0 ? 'satisfied' : truncated ? 'benchmark_timeout' : 'unsatisfied'
  }
  return {
    task: input.task,
    seed: input.seed,
    success: reward > 0,
    reward,
    steps: decisions.length,
    outcome,
    totalMs: Number((performance.now() - startedAt).toFixed(1)),
    decisions
  }
}

async function main(): Promise<void> {
  const tasks = (process.env.OFFGRID_BENCHMARK_TASKS ?? 'click-test')
    .split(',')
    .map((task) => task.trim())
    .filter(Boolean)
  const seeds = Number(process.env.OFFGRID_BENCHMARK_SEEDS ?? 1)
  const maxSteps = process.env.OFFGRID_BENCHMARK_MAX_STEPS
    ? Number(process.env.OFFGRID_BENCHMARK_MAX_STEPS)
    : undefined
  const modelPath = process.env.OFFGRID_DECISION_MODEL ?? DEFAULT_MODEL
  const reasonerPath = process.env.OFFGRID_REASONER_MODEL ?? DEFAULT_REASONER
  const server = startModelServer(modelPath, DECISION_PORT, 2_048)
  const reasoner = startModelServer(reasonerPath, REASONER_PORT, 8_192)
  server.stderr.pipe(process.stderr)
  reasoner.stderr.pipe(process.stderr)
  const worker = workerProcess()
  const shutdown = (): void => {
    worker.process.kill('SIGTERM')
    server.kill('SIGTERM')
    reasoner.kill('SIGTERM')
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  try {
    const coldStartedAt = performance.now()
    await Promise.all([
      waitForModelServer(server, DECISION_PORT),
      waitForModelServer(reasoner, REASONER_PORT)
    ])
    const coldStartMs = Number((performance.now() - coldStartedAt).toFixed(1))
    const results: RunResult[] = []
    for (const task of tasks) {
      for (let seed = 0; seed < seeds; seed += 1) {
        const result = await runTask({ task, seed, maxSteps, request: worker.request })
        results.push(result)
        const successes = results.filter((item) => item.success).length
        process.stderr.write(
          `[benchmark] completed=${results.length}/${tasks.length * seeds} success=${successes}/${results.length} task=${task} seed=${seed} outcome=${result.outcome} steps=${result.steps}\n`
        )
      }
    }
    const decisionTimes = results.flatMap((result) =>
      result.decisions.map((decision) => decision.decisionMs)
    )
    const sortedTimes = [...decisionTimes].sort((a, b) => a - b)
    const percentile = (fraction: number): number | null =>
      sortedTimes.length
        ? sortedTimes[
            Math.min(sortedTimes.length - 1, Math.ceil(sortedTimes.length * fraction) - 1)
          ]!
        : null
    process.stdout.write(
      `${JSON.stringify(
        {
          benchmark: 'BrowserGym MiniWoB',
          modelPath,
          reasonerPath,
          officialRewards: true,
          coldStartMs,
          tasks: results.length,
          successes: results.filter((result) => result.success).length,
          successRate:
            results.length > 0
              ? results.filter((result) => result.success).length / results.length
              : null,
          warmDecisionMedianMs: percentile(0.5),
          warmDecisionP95Ms: percentile(0.95),
          results
        },
        null,
        2
      )}\n`
    )
  } finally {
    worker.process.stdin.write(`${JSON.stringify({ operation: 'close' })}\n`)
    shutdown()
  }
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  )
  process.exitCode = 1
})
