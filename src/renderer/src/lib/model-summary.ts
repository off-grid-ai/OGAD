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

interface TextModelSummaryEntry {
  id: string
  name?: string
  remoteServerId?: string
}

/** Resolve the one active text/vision selection. Remote activation supersedes the
 * local llama-server selection, which may remain loaded as an implementation detail. */
export function resolveActiveTextModel(
  models: ReadonlyArray<TextModelSummaryEntry>,
  localActiveId: string | null | undefined,
  activeIds: ReadonlySet<string>
): { name: string | null; remote: boolean } {
  const remote = models.find((model) => model.remoteServerId && activeIds.has(model.id))
  if (remote) return { name: remote.name ?? remote.id, remote: true }
  return { name: resolveModelName(models, localActiveId), remote: false }
}
