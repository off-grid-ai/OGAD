import {
  MAX_COMPUTER_USE_REASONING_CHARS,
  MAX_COMPUTER_USE_TRACE_STEPS
} from '../../shared/computer-use-limits'
import type { ComputerUsePhase, ComputerUseStepDetail } from '../../shared/computer-use-step-detail'

export type { ComputerUsePhase, ComputerUseStepDetail } from '../../shared/computer-use-step-detail'

export const MAX_TASK_STEP_DETAILS = MAX_COMPUTER_USE_TRACE_STEPS
const MAX_TEXT_LENGTH = MAX_COMPUTER_USE_REASONING_CHARS
const MAX_FACTS = 12
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]'],
  [
    /(["']?)(api[_-]?key|access[_-]?token|authorization|password|secret)\1\s*[:=]\s*(["']?)(?:Bearer\s+)?[^\s,"'}]+\3/gi,
    '$2=[redacted]'
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi, 'Bearer [redacted]']
]

function safeText(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const redacted = SECRET_PATTERNS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    value
  )
  return redacted.length > MAX_TEXT_LENGTH
    ? `${redacted.slice(0, MAX_TEXT_LENGTH)}\n[details shortened]`
    : redacted
}

/** Typed values can contain passwords, one-time codes, or other private text. */
function redactTypedActionContent(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  let redacted = value
    .replace(/(\btype\s*\(\s*(?:content|text|value)\s*=\s*')[^']*'/gi, "$1[redacted]'")
    .replace(/(\btype\s*\(\s*(?:content|text|value)\s*=\s*")[^"]*"/gi, '$1[redacted]"')
    .replace(/\btype\s+"(?:\\.|[^"\\])*"/gi, 'type "[redacted]"')

  if (/"(?:action|type)"\s*:\s*"type"/i.test(redacted)) {
    redacted = redacted.replace(
      /("(?:content|text|value)"\s*:\s*")(?:(?:\\.)|[^"\\])*"/gi,
      '$1[redacted]"'
    )
  }
  return redacted
}

/** Keep live reasoning separate from the generic trace, bounded, and safe to persist. */
export function sanitizeComputerUseReasoning(value: unknown): string | undefined {
  const typedRedacted = redactTypedActionContent(value)
  if (!typedRedacted) return undefined
  const secretRedacted = SECRET_PATTERNS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    typedRedacted
  )
  return secretRedacted.slice(-MAX_COMPUTER_USE_REASONING_CHARS)
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function phase(value: unknown): ComputerUsePhase | undefined {
  switch (value) {
    case 'preparing':
    case 'observing':
    case 'thinking':
    case 'acting':
    case 'checking':
    case 'waiting':
    case 'paused':
    case 'complete':
    case 'failed':
    case 'stopped':
      return value
    default:
      return undefined
  }
}

/** Remove model-only reasoning while retaining the action and tool-call output users can audit. */
export function visibleComputerUseModelOutput(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const withoutClosedReasoning = value.replace(
    /<(?:think|analysis|reasoning)\b[^>]*>[\s\S]*?<\/(?:think|analysis|reasoning)>/gi,
    ''
  )
  const withoutOpenReasoning = withoutClosedReasoning.replace(
    /<(?:think|analysis|reasoning)\b[^>]*>[\s\S]*$/gi,
    ''
  )
  // UI-TARS can emit an untagged `Thought:` preface before its auditable
  // `Action:` line. It is the same hidden reasoning in a different envelope.
  const withoutThoughtPreface = withoutOpenReasoning
    .replace(/^\s*Thought:\s*[\s\S]*?(?=^\s*Action:)/gim, '')
    .replace(/^\s*Thought:\s*[\s\S]*$/gim, '')
  return safeText(redactTypedActionContent(withoutThoughtPreface))
}

/** Redact and bound observability before it reaches SQLite or a renderer. */
/** What callers may hand in, including fields we deliberately refuse to store. */
export type ComputerUseStepDetailInput = Partial<ComputerUseStepDetail> & { modelInput?: string }

/**
 * Takes a LOOSE input, not a ComputerUseStepDetail: this is the boundary that decides what is
 * allowed to be persisted, so it must be able to receive fields that are not in the stored shape
 * and drop them. `modelInput` is the case in point - callers still hand over a prompt echo, and
 * storing it cost 73% of the task payload on every list poll.
 */
export function sanitizeComputerUseStepDetail(
  input: ComputerUseStepDetailInput
): ComputerUseStepDetail {
  const screenshot = input.screenshot
  const originalWidth = finite(screenshot?.originalWidth)
  const originalHeight = finite(screenshot?.originalHeight)
  const inferenceWidth = finite(screenshot?.inferenceWidth)
  const inferenceHeight = finite(screenshot?.inferenceHeight)
  const viewportWidth = finite(screenshot?.viewportWidth)
  const viewportHeight = finite(screenshot?.viewportHeight)
  const executionStatus = input.execution?.status === 'failed' ? 'failed' : 'complete'
  const modelOutput = visibleComputerUseModelOutput(input.modelOutput ?? input.rawResponse)
  const decisionSummary = safeText(redactTypedActionContent(input.decisionSummary))
  const reasoning = safeText(redactTypedActionContent(input.reasoning))
  const decisionRationale = safeText(redactTypedActionContent(input.decisionRationale))
  const mappedAction = safeText(redactTypedActionContent(input.mappedAction))
  const actionCoordinateSpace =
    input.actionCoordinateSpace === 'viewport' ||
    (!input.actionCoordinateSpace && input.execution?.result === 'actuated')
      ? 'viewport'
      : 'inference'
  const screenshotAvailability =
    screenshot?.availability === 'unavailable' ? 'unavailable' : 'device_local'
  return {
    stepId: safeText(input.stepId)?.slice(0, 200) || 'step',
    at: finite(input.at) ?? Date.now(),
    ...(phase(input.phase) ? { phase: phase(input.phase) } : {}),
    ...(screenshot && originalWidth && originalHeight && inferenceWidth && inferenceHeight
      ? {
          screenshot: {
            ...(screenshotAvailability === 'device_local' && safeText(screenshot.path)
              ? { path: safeText(screenshot.path) }
              : {}),
            availability: screenshotAvailability,
            ...(safeText(screenshot.executionDeviceId)
              ? { executionDeviceId: safeText(screenshot.executionDeviceId)?.slice(0, 300) }
              : {}),
            ...(safeText(screenshot.executionDeviceName)
              ? { executionDeviceName: safeText(screenshot.executionDeviceName)?.slice(0, 200) }
              : {}),
            originalWidth,
            originalHeight,
            inferenceWidth,
            inferenceHeight,
            ...(viewportWidth && viewportHeight ? { viewportWidth, viewportHeight } : {})
          }
        }
      : {}),
    ...(input.retrievedFacts?.length
      ? {
          retrievedFacts: input.retrievedFacts
            .slice(0, MAX_FACTS)
            .map(safeText)
            .filter((fact): fact is string => Boolean(fact))
        }
      : {}),
    ...(input.tokenUsage
      ? {
          tokenUsage: {
            ...(finite(input.tokenUsage.input) !== undefined
              ? { input: finite(input.tokenUsage.input) }
              : {}),
            ...(finite(input.tokenUsage.output) !== undefined
              ? { output: finite(input.tokenUsage.output) }
              : {}),
            ...(finite(input.tokenUsage.context) !== undefined
              ? { context: finite(input.tokenUsage.context) }
              : {})
          }
        }
      : {}),
    ...(decisionSummary ? { decisionSummary } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(decisionRationale ? { decisionRationale } : {}),
    ...(modelOutput ? { modelOutput } : {}),
    ...(mappedAction ? { mappedAction } : {}),
    ...(mappedAction ? { actionCoordinateSpace } : {}),
    ...(input.execution
      ? {
          execution: {
            status: executionStatus,
            ...(finite(input.execution.durationMs) !== undefined
              ? { durationMs: finite(input.execution.durationMs) }
              : {}),
            ...(safeText(input.execution.result)
              ? { result: safeText(input.execution.result) }
              : {}),
            ...(safeText(input.execution.error) ? { error: safeText(input.execution.error) } : {})
          }
        }
      : {})
  }
}

/**
 * Redact and cap step details ON THE WAY IN. This is the single boundary where untrusted model
 * output and typed content are sanitized, so everything persisted is already safe to read back.
 */
export function boundComputerUseStepDetails(
  details: readonly ComputerUseStepDetail[]
): ComputerUseStepDetail[] {
  return details.slice(-MAX_TASK_STEP_DETAILS).map(sanitizeComputerUseStepDetail)
}

/**
 * Read back what boundComputerUseStepDetails already sanitized: enforce the cap, do NOT redact
 * again.
 *
 * Re-redacting on every hydration was the main thread's largest cost once embeddings moved off it —
 * a profile under load put ~24% of main-thread time in visibleComputerUseModelOutput (8.6%),
 * redactTypedActionContent (5.3%) and this parse (3.6%). The reason is the call pattern: upsert()
 * reads the row before every write, so each recordTaskRun — meaning each streamed reasoning token —
 * re-parsed and re-redacted every field of every step in a list that grows all task long, then
 * wrote it straight back unchanged. tasks:list paid it again per row on every poll.
 *
 * Sanitizing once at the write boundary is both cheaper and the honest single source of truth:
 * doing it twice invited the two copies to disagree about what "redacted" means.
 */
/**
 * Parsed results, keyed by the exact stored JSON.
 *
 * The same blob is re-parsed thousands of times per task: upsert() reads the row before every
 * write (so once per streamed reasoning token) and tasks:list re-reads every row on every poll,
 * while the JSON itself only changes when a step is actually appended. A profile taken DURING a
 * live web_use run put 35% of main-thread time in this parse alone, with the thread fully
 * saturated. The string is immutable and is its own cache key, so an unchanged blob is parsed once.
 *
 * Bounded, and each entry is replaced as soon as that task's details change, so this holds at most
 * one array per recent task rather than growing with the run.
 */
const parsedDetails = new Map<string, ComputerUseStepDetail[]>()
const MAX_PARSED_DETAIL_BLOBS = 64

export function storedComputerUseStepDetails(raw: string): ComputerUseStepDetail[] {
  const hit = parsedDetails.get(raw)
  if (hit) return hit
  let parsed: ComputerUseStepDetail[]
  try {
    const value = JSON.parse(raw) as unknown
    parsed = Array.isArray(value)
      ? (value as ComputerUseStepDetail[]).slice(-MAX_TASK_STEP_DETAILS)
      : []
  } catch {
    parsed = []
  }
  // Oldest-first eviction: Map preserves insertion order, so the first key is the stalest blob.
  if (parsedDetails.size >= MAX_PARSED_DETAIL_BLOBS) {
    const oldest = parsedDetails.keys().next().value
    if (oldest !== undefined) parsedDetails.delete(oldest)
  }
  parsedDetails.set(raw, parsed)
  return parsed
}
