import type { VisionContinuationCapsule } from './types'

export const MAX_CONTINUATION_DONE_ITEMS = 10
const MAX_DONE_CHARS = 96
const MAX_FIELD_CHARS = 160

export const CONTINUATION_CAPSULE_SCHEMA = {
  type: 'object',
  properties: {
    done: {
      type: 'array',
      items: { type: 'string', maxLength: MAX_DONE_CHARS },
      maxItems: MAX_CONTINUATION_DONE_ITEMS
    },
    next: { type: 'string', maxLength: MAX_FIELD_CHARS },
    remember: { type: 'string', maxLength: MAX_FIELD_CHARS }
  },
  required: ['done', 'next', 'remember'],
  additionalProperties: false
} as const

function boundedText(value: unknown, maxChars: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxChars) : ''
}

export function parseContinuationCapsule(
  value: unknown,
  maxDoneItems = MAX_CONTINUATION_DONE_ITEMS
): VisionContinuationCapsule | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (
    Object.keys(candidate).some((key) => !['done', 'next', 'remember'].includes(key)) ||
    !Array.isArray(candidate.done)
  ) {
    return null
  }
  const boundedDoneItems = Math.max(
    0,
    Math.min(MAX_CONTINUATION_DONE_ITEMS, Math.floor(maxDoneItems))
  )
  const done = (boundedDoneItems > 0 ? candidate.done.slice(-boundedDoneItems) : [])
    .map((item) => boundedText(item, MAX_DONE_CHARS))
    .filter(Boolean)
  return {
    done,
    next: boundedText(candidate.next, MAX_FIELD_CHARS),
    remember: boundedText(candidate.remember, MAX_FIELD_CHARS)
  }
}

export function formatContinuationCapsule(capsule: VisionContinuationCapsule | undefined): string {
  if (!capsule) return ''
  return [
    'Continuation capsule (bounded working state; replace it in the next decision):',
    `Done: ${capsule.done.length ? capsule.done.join('; ') : 'None yet'}`,
    `Next: ${capsule.next || 'Choose the next safe action'}`,
    `Remember: ${capsule.remember || 'No additional note'}`
  ].join('\n')
}

export function boundedContinuationCapsule(
  capsule: VisionContinuationCapsule,
  maxDoneItems = MAX_CONTINUATION_DONE_ITEMS
): VisionContinuationCapsule {
  return parseContinuationCapsule(capsule, maxDoneItems) ?? { done: [], next: '', remember: '' }
}

const APPROVED_ACTION_PREFIX = 'action approved: '

/** Rebuild the compact semantic action ledger when a fresh Vision runtime
 * resumes an Accessibility task. Task history is durable across one-action
 * recoveries; model-local trajectory state is not. */
export function continuationFromTaskSteps(
  steps: readonly string[],
  maxDoneItems: number,
  next: string
): VisionContinuationCapsule | undefined {
  if (maxDoneItems <= 0) return undefined
  const done = steps
    .map((step) => {
      if (step.startsWith(APPROVED_ACTION_PREFIX)) {
        return `Attempted: ${step.slice(APPROVED_ACTION_PREFIX.length)}`
      }
      return /^(?:pressed|clicked|hovered|scrolled|typed into|typed text|key |set \[)/i.test(step)
        ? `Attempted: ${step}`
        : null
    })
    .filter((step): step is string => step !== null)
  if (done.length === 0) return undefined
  return boundedContinuationCapsule(
    {
      done,
      next,
      remember: 'Do not repeat an earlier attempted action or content target.'
    },
    maxDoneItems
  )
}
