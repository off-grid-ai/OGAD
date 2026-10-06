// Every answer a turn has had, as the browser extension keeps them (‹ 1/2 ›). Pure.
//
// Regenerate and Resend both ask again; the answer they replace stays as an earlier version.
// The version on screen is the one shown, the one the model sees next, and the one saved.

export interface Versioned {
  readonly role: string
  readonly content: string
  readonly variants?: string[]
  readonly variantIndex?: number
}

/** The versions a new answer joins: the replaced answer's own, or that answer alone. */
export function priorVersions(answer: Versioned | undefined): string[] | null {
  if (!answer || answer.role !== 'assistant' || !answer.content.trim()) return null
  return answer.variants?.length ? answer.variants : [answer.content]
}

/** The answer to a user turn (what Resend on that turn replaces), before the next user turn. */
export function answerAfter<T extends Versioned>(
  messages: readonly T[],
  userIndex: number
): T | undefined {
  for (let i = userIndex + 1; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role === 'user') return undefined
    if (m.role === 'assistant' && m.content.trim()) return m
  }
  return undefined
}

/** Another version on screen: its text replaces the shown answer. Null at either end. */
export function showVersion(
  m: Versioned,
  direction: -1 | 1
): { content: string; variantIndex: number } | null {
  if (!m.variants?.length) return null
  const current = m.variantIndex ?? m.variants.length - 1
  const next = Math.max(0, Math.min(m.variants.length - 1, current + direction))
  return next === current ? null : { content: m.variants[next]!, variantIndex: next }
}
