// Pure helpers for the composer's active-model indicator. Zero IO so they unit-test
// without the app: format the running context window and resolve a model id to its
// display name. The hook (useActiveModelSummary) does the IPC and delegates here.

/** Format a context window in tokens as a compact label, e.g. 8192 -> "8K",
 *  131072 -> "128K". Local model contexts are powers of two, so divide by 1024.
 *  Returns null when unknown/zero so the UI can omit it. */
export function formatContextWindow(tokens?: number | null): string | null {
  if (!tokens || tokens <= 0) {
    return null
  }
  if (tokens < 1024) {
    return String(tokens)
  }
  return `${Math.round(tokens / 1024)}K`
}

/** Resolve an active model id to its catalog display name; falls back to the id when
 *  the catalog has no match (a just-imported model), null when there is no active id. */
export function resolveModelName(
  models: ReadonlyArray<{ id: string; name?: string }>,
  id: string | null | undefined
): string | null {
  if (!id) {
    return null
  }
  return models.find((m) => m.id === id)?.name ?? id
}

/** Apply active-model capability evidence before a Chat request is created. */
export function admitThinkingRequest(
  enabled: boolean,
  activeModelName: string | null,
  thinkingCapability: boolean | null
): boolean {
  // The hook publishes capability evidence only while its projection is ready. A missing model,
  // loading projection, failed projection, or unknown capability therefore fails closed.
  return enabled && activeModelName !== null && thinkingCapability === true
}

interface TextModelSummaryEntry {
  id: string
  name?: string
  remoteServerId?: string
  capabilities?: { thinking?: boolean }
}

/** Resolve the one active text/vision selection. Remote activation supersedes the
 * local llama-server selection, which may remain loaded as an implementation detail. */
export function resolveActiveTextModel(
  models: ReadonlyArray<TextModelSummaryEntry>,
  selectedTextId: string | null | undefined
): { name: string | null; remote: boolean; thinking: boolean | null } {
  const selected = models.find((model) => model.id === selectedTextId)
  return {
    name: resolveModelName(models, selectedTextId),
    remote: Boolean(selected?.remoteServerId),
    thinking:
      typeof selected?.capabilities?.thinking === 'boolean' ? selected.capabilities.thinking : null
  }
}
