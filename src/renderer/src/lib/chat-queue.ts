// Pure per-conversation send/queue routing — testable without React. Fixes the
// multi-tab corruption: a send and any queued message must belong to their OWN
// conversation, never to whatever tab happens to be active when they run.

/** Should a new send for `convId` queue (a generation is already running for THAT
 *  conversation) or run now? A null conversation (fresh, unsaved chat) never has an
 *  in-flight generation of its own, so it always runs. */
export function shouldQueue(convId: string | null, generating: ReadonlySet<string>): boolean {
  return convId != null && generating.has(convId)
}

/** Append an item to a conversation's queue (immutably, FIFO). */
export function enqueue<T>(
  byConv: Record<string, T[]>,
  convId: string,
  item: T,
  first = false
): Record<string, T[]> {
  return {
    ...byConv,
    [convId]: first ? [item, ...(byConv[convId] ?? [])] : [...(byConv[convId] ?? []), item]
  }
}

/** Pop the next queued item for a conversation; returns it + the updated map. */
export function dequeue<T>(
  byConv: Record<string, T[]>,
  convId: string
): { item: T | undefined; next: Record<string, T[]> } {
  const q = byConv[convId] ?? []
  if (!q.length) return { item: undefined, next: byConv }
  return { item: q[0], next: { ...byConv, [convId]: q.slice(1) } }
}

/** How many sends are waiting for a conversation (for the "N queued" chip). */
export function queuedCount(byConv: Record<string, unknown[]>, convId: string | null): number {
  return convId ? (byConv[convId]?.length ?? 0) : 0
}

/** Drop every queued send for a conversation (used when the user hits Stop) without
 *  touching other conversations' queues. Immutable. */
export function clearQueue<T>(byConv: Record<string, T[]>, convId: string): Record<string, T[]> {
  if (!(convId in byConv)) return byConv
  const next = { ...byConv }
  delete next[convId]
  return next
}
