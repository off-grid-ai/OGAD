interface ActiveModels {
  text: string | null
  image: string | null
  speech: string | null
  transcription: string | null
  computer_use: string | null
}

interface SnapshotInput<Model> {
  kinds: readonly string[]
  models: readonly Model[]
  installed?: readonly string[]
  activeIds?: readonly string[]
  active?: Partial<ActiveModels>
  computerUse?: unknown
}

/** Canonical renderer boundary fixture for the single model-control read contract. */
export function modelControlSnapshot<Model>(input: SnapshotInput<Model>) {
  return {
    kinds: input.kinds,
    models: input.models,
    installed: input.installed ?? [],
    activeIds: input.activeIds ?? [],
    active: {
      text: null,
      image: null,
      speech: null,
      transcription: null,
      computer_use: null,
      ...input.active
    },
    computerUse: input.computerUse ?? null
  }
}
