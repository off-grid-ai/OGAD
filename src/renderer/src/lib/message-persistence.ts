// Pure carrier logic for persisting assistant-turn metadata through the RAG
// message `context` blob. The chat "Thinking"/reasoning block is held only in
// React state while a turn streams; unless it rides in the persisted `context`
// it VANISHES on reload/conversation-remap. `context` is a freeform JSON blob
// that `addRagMessage` already persists and `mapRagMessages` already parses
// (toolCalls / image / attachments all restore from it), so reasoning rides
// there too — no schema or IPC signature change.
//
// These two functions are exact inverses:
//   buildAssistantContext(baseCtx, { reasoning }) → ctx   (write path)
//   readReasoning(ctx) → string | undefined              (read path)
import type { ResponseCutoffContract } from '../../../shared/ipc-contracts'
import type { GenerationMetrics } from '../../../shared/generation-metrics'

/** Order of readable reasoning and tool calls in one assistant reply. */
export type AssistantTimelineEntry =
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; toolIndex: number }

/** Extra assistant-turn fields that ride in the persisted `context` blob. */
export interface AssistantContextExtras {
  /** The model's reasoning / "Thinking" text for the turn, if any. */
  reasoning?: string
  /** Why the model stopped before completing the response, if applicable. */
  cutoff?: ResponseCutoffContract
  /** How the generation performed - rates, token counts, time to first token. */
  metrics?: GenerationMetrics
  /** Optional for older replies, which keep their original thinking-then-tools layout. */
  timeline?: AssistantTimelineEntry[]
}

/**
 * Merge assistant-turn extras into the base context object without dropping any
 * existing fields (unified/toolCalls/image/attachments). Only attaches
 * `reasoning` when it is non-empty — an absent or blank reasoning must NOT add
 * an empty-string key (no persisted noise, and readReasoning stays undefined).
 * Returns `undefined` only when there is genuinely nothing to persist, matching
 * the existing "no context" convention.
 */
export function buildAssistantContext(
  baseCtx: Record<string, unknown> | undefined,
  extras: AssistantContextExtras = {}
): Record<string, unknown> | undefined {
  const reasoning = extras.reasoning?.trim() ? extras.reasoning : undefined
  if (
    !baseCtx &&
    reasoning === undefined &&
    extras.cutoff === undefined &&
    extras.metrics === undefined &&
    !extras.timeline?.length
  ) {
    return undefined
  }
  const ctx: Record<string, unknown> = { ...(baseCtx ?? {}) }
  if (reasoning !== undefined) ctx.reasoning = reasoning
  if (extras.cutoff !== undefined) ctx.cutoff = extras.cutoff
  if (extras.metrics !== undefined) ctx.metrics = extras.metrics
  if (extras.timeline?.length) ctx.timeline = extras.timeline
  return ctx
}

/** Ignore malformed durable entries instead of passing them to the chat timeline. */
export function readAssistantTimeline(ctx: unknown): AssistantTimelineEntry[] | undefined {
  if (!ctx || typeof ctx !== 'object') return undefined
  const raw = (ctx as { timeline?: unknown }).timeline
  if (!Array.isArray(raw)) return undefined
  const entries: AssistantTimelineEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    if (entry.kind === 'thinking' && typeof entry.text === 'string' && entry.text.trim()) {
      entries.push({ kind: 'thinking', text: entry.text })
    } else if (
      entry.kind === 'tool' &&
      typeof entry.toolIndex === 'number' &&
      Number.isSafeInteger(entry.toolIndex) &&
      entry.toolIndex >= 0
    ) {
      entries.push({ kind: 'tool', toolIndex: entry.toolIndex })
    }
  }
  return entries.length ? entries : undefined
}

/**
 * Restore the reasoning text from a persisted context blob. The exact inverse
 * of buildAssistantContext — returns `undefined` (never an empty string) when
 * there is no usable reasoning, so a restored message renders no empty
 * "Thinking" block.
 */
export function readReasoning(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== 'object') return undefined
  const r = (ctx as { reasoning?: unknown }).reasoning
  return typeof r === 'string' && r.trim() ? r : undefined
}

/** Restore only a valid persisted cutoff marker. Context is durable user data, so
 * malformed or old values are ignored instead of reaching presentation state. */
export function readResponseCutoff(ctx: unknown): ResponseCutoffContract | undefined {
  if (!ctx || typeof ctx !== 'object') return undefined
  const cutoff = (ctx as { cutoff?: unknown }).cutoff
  if (!cutoff || typeof cutoff !== 'object') return undefined
  const value = cutoff as { reason?: unknown; maxTokens?: unknown }
  if (
    value.reason !== 'max_tokens' ||
    typeof value.maxTokens !== 'number' ||
    !Number.isInteger(value.maxTokens) ||
    value.maxTokens < 1
  ) {
    return undefined
  }
  return { reason: value.reason, maxTokens: value.maxTokens }
}

/**
 * Restore persisted generation metrics.
 *
 * Every field is read independently and only kept when it is a positive finite number. Context is
 * durable user data written by older builds, so a partial or malformed blob must degrade to fewer
 * numbers rather than render NaN under someone's message.
 */
export function readGenerationMetrics(ctx: unknown): GenerationMetrics | undefined {
  if (!ctx || typeof ctx !== 'object') return undefined
  const raw = (ctx as { metrics?: unknown }).metrics
  if (!raw || typeof raw !== 'object') return undefined
  const source = raw as Record<string, unknown>
  const keys = [
    'timeToFirstTokenSeconds',
    'totalSeconds',
    'decodeTokensPerSecond',
    'prefillTokensPerSecond',
    'promptTokens',
    'completionTokens',
    'contextWindowTokens',
    'estimatedPromptTokens'
  ] as const
  const metrics: Record<string, number | string> = {}
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) metrics[key] = value
  }
  if (typeof source.modelName === 'string' && source.modelName.trim()) {
    metrics.modelName = source.modelName.trim()
  }
  return Object.keys(metrics).length ? (metrics as GenerationMetrics) : undefined
}
