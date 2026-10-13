// Keep a conversation's offered tools stable from turn to turn.
//
// llama-server renders tool schemas inside the first (system) message, ahead of the whole
// history. Re-ranking tools per message changes that prefix whenever the selection moves, so
// the server re-reads the entire conversation (~10s for 4K tokens on Apple Silicon) instead
// of reusing its prompt cache (~0.3s). Tools offered earlier in a conversation stay, in the
// same order; tools newly selected for this message are appended after them.

type ToolSchema = unknown

const MAX_CONVERSATIONS = 64
const offeredByConversation = new Map<string, string[]>()

export function toolSchemaName(schema: ToolSchema): string | undefined {
  const name = (schema as { function?: { name?: unknown } } | null)?.function?.name
  return typeof name === 'string' && name ? name : undefined
}

/** Earlier-offered tools still available (in their earlier order), then this turn's new picks. */
export function mergeStickyTools(
  previousNames: readonly string[],
  selected: readonly ToolSchema[],
  available: readonly ToolSchema[]
): ToolSchema[] {
  const byName = new Map<string, ToolSchema>()
  for (const schema of available) {
    const name = toolSchemaName(schema)
    if (name && !byName.has(name)) byName.set(name, schema)
  }
  const merged: ToolSchema[] = []
  const included = new Set<string>()
  for (const name of previousNames) {
    const schema = byName.get(name)
    if (schema === undefined || included.has(name)) continue
    merged.push(schema)
    included.add(name)
  }
  for (const schema of selected) {
    const name = toolSchemaName(schema)
    if (name && included.has(name)) continue
    merged.push(schema)
    if (name) included.add(name)
  }
  return merged
}

export function previousOfferedTools(conversationId: string | undefined): readonly string[] {
  return conversationId ? (offeredByConversation.get(conversationId) ?? []) : []
}

export function rememberOfferedTools(
  conversationId: string | undefined,
  tools: readonly ToolSchema[]
): void {
  if (!conversationId) return
  offeredByConversation.delete(conversationId)
  offeredByConversation.set(
    conversationId,
    tools.flatMap((schema) => {
      const name = toolSchemaName(schema)
      return name ? [name] : []
    })
  )
  while (offeredByConversation.size > MAX_CONVERSATIONS) {
    const oldest = offeredByConversation.keys().next().value
    if (oldest === undefined) break
    offeredByConversation.delete(oldest)
  }
}
