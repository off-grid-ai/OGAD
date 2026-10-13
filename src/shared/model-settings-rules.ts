import { modelSupportsKind } from '@offgrid/models'

/** Desktop Models tab membership, including vision models on Text. */
export function modelShowsOnTab(
  model: { id: string; kind: string; grounder?: boolean },
  tab: string
): boolean {
  return (
    !model.id.endsWith('+MTP') &&
    (modelSupportsKind(
      model as Parameters<typeof modelSupportsKind>[0],
      tab as Parameters<typeof modelSupportsKind>[1]
    ) ||
      (tab === 'text' &&
        modelSupportsKind(model as Parameters<typeof modelSupportsKind>[0], 'vision')))
  )
}

/** Agent uses Desktop's tool planner preflight, including its JSON fallback for local models. */
export function activeTextAvailability(
  active: { vision: boolean } | null,
  plannerReason: string | null,
  toolsEnabled: boolean
): { vision: boolean; agent: boolean; reasonIfNot?: string } {
  const reason = !active
    ? 'No active text model.'
    : !toolsEnabled
      ? 'Tools are disabled.'
      : plannerReason
  return {
    vision: active?.vision ?? false,
    agent: !reason,
    ...(reason ? { reasonIfNot: reason } : {})
  }
}

/** Remote vision is advertised by the saved Desktop model catalog, never inferred from a name. */
export function remoteTextVision(
  model: { inputModalities?: readonly string[] } | undefined
): boolean {
  return model?.inputModalities?.includes('image') === true
}
