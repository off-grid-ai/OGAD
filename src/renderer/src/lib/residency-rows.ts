// Model-memory (residency) rows — the SINGLE source of truth for which modalities are
// listed, their copy, and the accessible names of their switches.
//
// This is deliberately a pure, import-free module: the renderer builds the UI from it and
// the E2E suite imports it to derive the selectors it queries. Before this existed the
// switch labels were an inline template in the markup and the E2E spec re-hardcoded them —
// they drifted ("Chat model residency" vs the real "Chat and capture model residency",
// "Dictation (speech-to-text) residency" vs "Dictation residency") and the spec silently
// stopped matching anything. Deriving both sides from here makes a rename fail a test
// instead of orphaning one.

type ResidencyModality = import('../../../shared/runtime-residency-types').Modality

export interface ResidencyRow {
  modality: ResidencyModality
  label: string
  hint: string
  /** Locked rows are always resident and their switch is disabled. */
  locked?: boolean
}

export const RESIDENCY_ROWS: ResidencyRow[] = [
  {
    modality: 'llm',
    label: 'Text, vision, and reasoning',
    locked: true,
    hint: 'Shared by Chat, capture, and Computer Use / Web Use reasoning. Other models can free this memory temporarily.'
  },
  {
    modality: 'image',
    label: 'Image generation',
    hint: 'In-memory cuts a typical cold start from about 45s to about 7s.'
  },
  {
    modality: 'stt',
    label: 'Transcription and dictation',
    hint: 'In-memory keeps Whisper ready for live speech. Parakeet loads per use.'
  },
  {
    modality: 'tts',
    label: 'Text-to-speech',
    hint: 'In-memory keeps the voice model ready; on-demand frees about 330MB.'
  },
  {
    modality: 'grounding',
    label: 'Computer Use / Web Use grounding',
    hint: 'Keeps the local specialist ready between tasks. On demand frees it after the last active task.'
  },
  {
    modality: 'decision',
    label: 'Computer Use / Web Use decider',
    hint: 'Keeps the local decision model ready between tasks. Low-memory tasks can still unload it.'
  },
  {
    modality: 'embeddings',
    label: 'Embeddings (search and RAG)',
    hint: 'Keeps the search model ready. On demand frees it after each embedding request.'
  }
]

/** Accessible name of a row's residency switch. Used by the markup AND by E2E selectors. */
export const residencySwitchLabel = (row: Pick<ResidencyRow, 'label'>): string =>
  `${row.label} residency`

/** The status text shown beside a row's switch. */
export const residencyStatusText = (
  row: Pick<ResidencyRow, 'locked'>,
  resident: boolean
): string => (row.locked ? 'in-memory (required)' : resident ? 'in-memory' : 'on-demand')

export const lockedResidencyRows = (): ResidencyRow[] => RESIDENCY_ROWS.filter((r) => r.locked)
export const unlockedResidencyRows = (): ResidencyRow[] => RESIDENCY_ROWS.filter((r) => !r.locked)
