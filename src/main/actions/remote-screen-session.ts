import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import type { ComputerUseModelStrategy } from '../../shared/computer-use-settings'
import type { ScreenTaskKind } from '../../shared/remote-screen-privacy'
import type { RemoteTextModelConnection } from '../llm/remote-chat'

export type ComputerUseRunMetric =
  | 'axSteps'
  | 'visionSteps'
  | 'actions'
  | 'groundingCalls'
  | 'reasoningCalls'
  | 'deciderCalls'

export interface ComputerUseRunTelemetry {
  runId: string
  actionId: string
  task: string
  startedAt: number
  strategy: ComputerUseModelStrategy
  reasoningModel: string
  groundingModel: string
  deciderModel: string
  axSteps: number
  visionSteps: number
  actions: number
  groundingCalls: number
  reasoningCalls: number
  deciderCalls: number
  modelCallIndex: number
}

export interface RemoteScreenTaskSession {
  taskKind: ScreenTaskKind
  modelStrategy: ComputerUseModelStrategy
  activeServer: RemoteTextModelConnection | null
  telemetry?: ComputerUseRunTelemetry
}

const sessions = new AsyncLocalStorage<Readonly<RemoteScreenTaskSession>>()

/** Bind privacy, model selection, and remote transport to one task-start snapshot. */
export function runWithRemoteScreenTaskSession<T>(
  session: RemoteScreenTaskSession,
  task: () => Promise<T>
): Promise<T> {
  const parent = sessions.getStore()
  const activeServer = session.activeServer ? Object.freeze({ ...session.activeServer }) : null
  return sessions.run(
    Object.freeze({ ...session, activeServer, telemetry: session.telemetry ?? parent?.telemetry }),
    task
  )
}

export function currentRemoteScreenTaskSession(): Readonly<RemoteScreenTaskSession> | undefined {
  return sessions.getStore()
}

function modelName(server: RemoteTextModelConnection | null): string {
  return server ? `${server.id}/${server.model}` : ''
}

export function createComputerUseRunTelemetry(input: {
  actionId: string
  task: string
  strategy: ComputerUseModelStrategy
  reasoningServer: RemoteTextModelConnection | null
  groundingServer: RemoteTextModelConnection | null
  deciderServer: RemoteTextModelConnection | null
}): ComputerUseRunTelemetry {
  const startedAt = Date.now()
  return {
    runId: `${input.actionId}:${startedAt}`,
    actionId: input.actionId,
    task: input.task,
    startedAt,
    strategy: input.strategy,
    reasoningModel: modelName(input.reasoningServer),
    groundingModel: modelName(input.groundingServer),
    deciderModel: modelName(input.deciderServer),
    axSteps: 0,
    visionSteps: 0,
    actions: 0,
    groundingCalls: 0,
    reasoningCalls: 0,
    deciderCalls: 0
    ,modelCallIndex: 0
  }
}

export function recordComputerUseMetric(metric: ComputerUseRunMetric, amount = 1): void {
  const telemetry = sessions.getStore()?.telemetry
  if (telemetry) telemetry[metric] += amount
}

const CSV_HEADER = [
  'run_id',
  'action_id',
  'started_at',
  'ended_at',
  'duration_ms',
  'task',
  'status',
  'total_steps',
  'ax_steps',
  'vision_steps',
  'actions',
  'grounding_calls',
  'reasoning_calls',
  'decider_calls',
  'strategy',
  'reasoning_model',
  'grounding_model',
  'decider_model',
  'failure'
].join(',')

function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

let csvWrites = Promise.resolve()

const MODEL_CALL_CSV_HEADER = [
  'run_id',
  'action_id',
  'call_index',
  'started_at',
  'ended_at',
  'duration_ms',
  'stage',
  'rail',
  'role',
  'model',
  'status',
  'request',
  'response',
  'error'
].join(',')

function traceValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[image data omitted]')
  }
  try {
    return JSON.stringify(value, (key, item) => {
      if (typeof item === 'string' && item.startsWith('data:image/')) return '[image data omitted]'
      if (/imageData|screenshotDataUrl/i.test(key)) return '[image data omitted]'
      return item
    })
  } catch {
    return String(value)
  }
}

/** Append one model request and response for the active Computer Use run. */
export function recordComputerUseModelCall(input: {
  role: 'reasoning' | 'decider' | 'grounding'
  stage: string
  rail: 'ax' | 'vision'
  request: unknown
  response?: unknown
  error?: unknown
  startedAt: number
  model?: string
}): Promise<void> {
  const telemetry = sessions.getStore()?.telemetry
  if (!telemetry) return Promise.resolve()
  telemetry.modelCallIndex += 1
  const endedAt = Date.now()
  const model =
    input.model ??
    (input.role === 'decider'
      ? telemetry.deciderModel
      : input.role === 'grounding'
        ? telemetry.groundingModel
        : telemetry.reasoningModel)
  const error = input.error instanceof Error ? input.error.message : input.error
  const row = [
    telemetry.runId,
    telemetry.actionId,
    telemetry.modelCallIndex,
    new Date(input.startedAt).toISOString(),
    new Date(endedAt).toISOString(),
    endedAt - input.startedAt,
    input.stage,
    input.rail,
    input.role,
    model,
    error === undefined ? 'completed' : 'failed',
    traceValue(input.request),
    input.response === undefined ? '' : traceValue(input.response),
    error === undefined ? '' : traceValue(error)
  ]
    .map(csvCell)
    .join(',')
  csvWrites = csvWrites
    .catch(() => undefined)
    .then(async () => {
      const directory = path.join(app.getPath('userData'), 'reports')
      const file = path.join(directory, 'computer-use-model-calls.csv')
      await mkdir(directory, { recursive: true })
      const existingSize = await stat(file).then((value) => value.size).catch(() => 0)
      await appendFile(
        file,
        `${existingSize === 0 ? `${MODEL_CALL_CSV_HEADER}\n` : ''}${row}\n`,
        'utf8'
      )
    })
  return csvWrites
}

/** Append one terminal row for a Computer Use run. The file opens directly in Excel. */
export function finishComputerUseRunTelemetry(
  telemetry: ComputerUseRunTelemetry,
  result: { ok: boolean; detail?: string }
): Promise<void> {
  const endedAt = Date.now()
  const row = [
    telemetry.runId,
    telemetry.actionId,
    new Date(telemetry.startedAt).toISOString(),
    new Date(endedAt).toISOString(),
    endedAt - telemetry.startedAt,
    telemetry.task,
    result.ok ? 'completed' : 'failed',
    telemetry.axSteps + telemetry.visionSteps,
    telemetry.axSteps,
    telemetry.visionSteps,
    telemetry.actions,
    telemetry.groundingCalls,
    telemetry.reasoningCalls,
    telemetry.deciderCalls,
    telemetry.strategy,
    telemetry.reasoningModel,
    telemetry.groundingModel,
    telemetry.deciderModel,
    result.ok ? '' : (result.detail ?? 'Computer Use failed.')
  ]
    .map(csvCell)
    .join(',')
  csvWrites = csvWrites
    .catch(() => undefined)
    .then(async () => {
      const directory = path.join(app.getPath('userData'), 'reports')
      const file = path.join(directory, 'computer-use-runs.csv')
      await mkdir(directory, { recursive: true })
      const existingSize = await stat(file).then((value) => value.size).catch(() => 0)
      await appendFile(file, `${existingSize === 0 ? `${CSV_HEADER}\n` : ''}${row}\n`, 'utf8')
      console.log(`[computer-use] run metrics appended to ${file}`)
    })
  return csvWrites
}
