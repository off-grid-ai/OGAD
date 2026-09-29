export const BACKEND_MODALITIES = [
  'llm', 'image', 'stt', 'tts', 'grounding', 'decision', 'embeddings'
] as const

export type BackendModality = (typeof BACKEND_MODALITIES)[number]
export type BackendPreference = 'auto' | 'cuda' | 'vulkan' | 'metal' | 'webgpu' | 'directml' | 'cpu'
export type BackendPreferences = Record<BackendModality, BackendPreference>

export function backendChoices(modality: BackendModality, platform: string): BackendPreference[] {
  const native = platform === 'darwin' ? ['metal'] : ['cuda', 'vulkan']
  const onnx = platform === 'darwin'
    ? ['metal', 'webgpu']
    : platform === 'win32'
      ? ['cuda', 'directml', 'webgpu']
      : ['cuda', 'webgpu']
  const accelerated = modality === 'tts' || modality === 'embeddings'
    ? onnx
    : modality === 'stt' && platform === 'win32'
      ? ['cuda']
      : native
  return ['auto', ...accelerated, 'cpu'] as BackendPreference[]
}

export function normalizeBackendPreferences(value: unknown, platform: string): BackendPreferences {
  const saved = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return Object.fromEntries(BACKEND_MODALITIES.map((modality) => {
    const choice = saved[modality]
    return [modality, backendChoices(modality, platform).includes(choice as BackendPreference)
      ? choice : 'auto']
  })) as BackendPreferences
}

/** CPU is explicit. Other choices are tried first and can fall back to the normal ladder. */
export function prioritizeBackend<T>(
  candidates: T[], preference: BackendPreference, identify: (candidate: T) => BackendPreference
): T[] {
  if (preference === 'auto') return candidates
  if (preference === 'cpu') return candidates.filter((candidate) => identify(candidate) === 'cpu')
  return [...candidates.filter((candidate) => identify(candidate) === preference),
    ...candidates.filter((candidate) => identify(candidate) !== preference)]
}
