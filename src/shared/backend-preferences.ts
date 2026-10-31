import {
  BACKEND_MODALITIES,
  normalizeBackendPreference,
  type BackendModality,
  type BackendPreference,
  type BackendPreferences
} from '@offgrid/models'
export {
  BACKEND_MODALITIES,
  type BackendModality,
  type BackendPreference,
  type BackendPreferences
} from '@offgrid/models'

export function backendChoices(modality: BackendModality, platform: string): BackendPreference[] {
  const native = platform === 'darwin' ? ['metal'] : ['cuda', 'vulkan']
  const onnx =
    platform === 'darwin'
      ? ['metal', 'webgpu']
      : platform === 'win32'
        ? ['cuda', 'directml', 'webgpu']
        : ['cuda', 'webgpu']
  const accelerated = modality === 'tts' || modality === 'embeddings' ? onnx : native
  return ['auto', ...accelerated, 'cpu'] as BackendPreference[]
}

export function normalizeBackendPreferences(value: unknown, platform: string): BackendPreferences {
  const saved = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return Object.fromEntries(
    BACKEND_MODALITIES.map((modality) => {
      const choice = normalizeBackendPreference(modality, saved[modality])
      return [
        modality,
        backendChoices(modality, platform).includes(choice as BackendPreference) ? choice : 'auto'
      ]
    })
  ) as BackendPreferences
}
