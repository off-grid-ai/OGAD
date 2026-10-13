// Pure transforms for the /v1/models response. No I/O. Extracted from
// model-server.ts so the capability -> kind tagging, the model-entry builder,
// and the ollama-style mirror are unit-testable. The handler still does the
// actual upstream fetch + active-model lookups; it feeds the results here.

/** Tag an upstream LLM entry chat vs vision from its advertised capabilities. */
export function tagLlmEntry(m: Record<string, unknown>): Record<string, unknown> {
  const caps = Array.isArray(m.capabilities) ? (m.capabilities as string[]) : []
  return { ...m, kind: caps.includes('multimodal') || caps.includes('vision') ? 'vision' : 'chat' }
}

/** Tag every upstream LLM entry. */
export function tagLlmEntries(upData: Record<string, unknown>[]): Record<string, unknown>[] {
  return upData.map(tagLlmEntry)
}

/** Build a canonical /v1/models entry for a non-LLM modality pick. */
export function modelEntry(
  id: string,
  kind: string,
  now: number,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { id, object: 'model', created: now, owned_by: 'off-grid', kind, ...extra }
}

/** Mirror the canonical data list into the ollama-style `models` array. */
export function ollamaMirror(data: Record<string, unknown>[]): Record<string, unknown>[] {
  return data.map((m) => ({ name: m.id, model: m.id, type: 'model', kind: m.kind }))
}

export function specialistModelEntries(
  catalog: readonly { id: string; name: string; kind: string; tags?: readonly string[] }[],
  installed: readonly string[],
  now: number
): Record<string, unknown>[] {
  return catalog
    .filter((model) => model.kind === 'computer_use' && installed.includes(model.id))
    .map((model) =>
      modelEntry(model.id, model.tags?.includes('Decision') ? 'chat' : 'vision', now, {
        name: model.name,
        capabilities: model.tags?.includes('Decision') ? [] : ['vision'],
        architecture: {
          input_modalities: model.tags?.includes('Decision') ? ['text'] : ['text', 'image'],
          output_modalities: model.tags?.includes('Decision') ? ['decisions'] : ['text']
        }
      })
    )
}

/** Complete installed chat models can be selected independently of the active pick. */
export function installedTextModelEntries(
  catalog: readonly { id: string; name: string; kind: string; remoteServerId?: string }[],
  installed: readonly string[], now: number
): Record<string, unknown>[] {
  return catalog.filter((model) => !model.remoteServerId &&
    (model.kind === 'text' || model.kind === 'vision') && installed.includes(model.id)
  ).map((model) => modelEntry(model.id, model.kind === 'vision' ? 'vision' : 'chat', now, {
    name: model.name,
    capabilities: model.kind === 'vision' ? ['vision'] : []
  }))
}
