// Single source of truth for the model-kind display label (grouping headers on
// the Models screen + the storage panel). It was defined twice — ModelsScreen and
// setup/StoragePanel — and had already drifted (StoragePanel carried an extra
// `other` bucket). This is the superset; both callers use `modelKindLabel`.

export const MODEL_KIND_LABELS: Record<string, string> = {
  text: 'Text',
  vision: 'Vision',
  computer_use: 'Computer Use',
  image: 'Image',
  voice: 'Voice',
  transcription: 'Transcription',
  other: 'Other'
}

/** Display label for a model kind, falling back to the raw kind for anything
 *  outside the known set. */
export function modelKindLabel(kind: string): string {
  return MODEL_KIND_LABELS[kind] ?? kind
}
