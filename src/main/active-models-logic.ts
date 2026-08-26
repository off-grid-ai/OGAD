export type Modality = 'computer_use' | 'image' | 'speech' | 'transcription'

/** Map a catalog kind to its stateless runtime modality. Chat kinds return null. */
export function modalityForKind(kind?: string | null): Modality | null {
  switch (kind) {
    case 'computer_use':
      return 'computer_use'
    case 'image':
      return 'image'
    case 'voice':
    case 'speech':
      return 'speech'
    case 'transcription':
      return 'transcription'
    default:
      return null
  }
}

/** Decide whether an installed model is active from the authoritative selections. */
export function isModelActive(opts: {
  kind?: string | null
  id: string
  primaryFile?: string | null
  activeChatId: string | null
  modals: Record<Modality, string | null>
}): boolean {
  const modal = modalityForKind(opts.kind)
  if (modal) {
    const chosen = opts.modals[modal]
    return chosen != null && (chosen === opts.id || chosen === opts.primaryFile)
  }
  return opts.id === opts.activeChatId
}
