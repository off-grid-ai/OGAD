export interface ComputerUseStepDetail {
  stepId: string
  at: number
  modelInput?: string
  screenshot?: {
    path?: string
    originalWidth: number
    originalHeight: number
    inferenceWidth: number
    inferenceHeight: number
  }
  retrievedFacts?: string[]
  tokenUsage?: { input?: number; output?: number; context?: number }
  rawResponse?: string
  mappedAction?: string
  execution?: { status: 'complete' | 'failed'; durationMs?: number; result?: string; error?: string }
}

export const MAX_TASK_STEP_DETAILS = 50
const MAX_TEXT_LENGTH = 12_000
const MAX_FACTS = 12
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]'],
  [
    /(["']?)(api[_-]?key|access[_-]?token|authorization|password|secret)\1\s*[:=]\s*(["']?)(?:Bearer\s+)?[^\s,"'}]+\3/gi,
    '$2=[redacted]'
  ],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/gi, 'Bearer [redacted]']
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

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Redact and bound observability before it reaches SQLite or a renderer. */
export function sanitizeComputerUseStepDetail(input: ComputerUseStepDetail): ComputerUseStepDetail {
  const screenshot = input.screenshot
  const originalWidth = finite(screenshot?.originalWidth)
  const originalHeight = finite(screenshot?.originalHeight)
  const inferenceWidth = finite(screenshot?.inferenceWidth)
  const inferenceHeight = finite(screenshot?.inferenceHeight)
  const executionStatus = input.execution?.status === 'failed' ? 'failed' : 'complete'
  return {
    stepId: safeText(input.stepId)?.slice(0, 200) || 'step',
    at: finite(input.at) ?? Date.now(),
    ...(safeText(input.modelInput) ? { modelInput: safeText(input.modelInput) } : {}),
    ...(screenshot && originalWidth && originalHeight && inferenceWidth && inferenceHeight
      ? {
          screenshot: {
            ...(safeText(screenshot.path) ? { path: safeText(screenshot.path) } : {}),
            originalWidth,
            originalHeight,
            inferenceWidth,
            inferenceHeight
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
    ...(safeText(input.rawResponse) ? { rawResponse: safeText(input.rawResponse) } : {}),
    ...(safeText(input.mappedAction) ? { mappedAction: safeText(input.mappedAction) } : {}),
    ...(input.execution
      ? {
          execution: {
            status: executionStatus,
            ...(finite(input.execution.durationMs) !== undefined
              ? { durationMs: finite(input.execution.durationMs) }
              : {}),
            ...(safeText(input.execution.result) ? { result: safeText(input.execution.result) } : {}),
            ...(safeText(input.execution.error) ? { error: safeText(input.execution.error) } : {})
          }
        }
      : {})
  }
}

export function boundComputerUseStepDetails(
  details: readonly ComputerUseStepDetail[]
): ComputerUseStepDetail[] {
  return details.slice(-MAX_TASK_STEP_DETAILS).map(sanitizeComputerUseStepDetail)
}
