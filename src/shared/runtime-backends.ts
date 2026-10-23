/** Live model placement. Availability and model selection are separate from residency. */
export type RuntimeId =
  | 'chat'
  | 'image'
  | 'video'
  | 'speech'
  | 'transcription'
  | 'embeddings'
  | 'grounding'
  | 'decision'
export interface RuntimeBackend {
  id: RuntimeId
  model?: string
  state: 'loading' | 'loaded' | 'stopped' | 'error' | 'unavailable'
  backend?: string
  device?: string
  detail?: string
}

export function runtimeBackendLabel(value?: RuntimeBackend): string {
  if (value?.state === 'unavailable') return 'Status unavailable'
  if (!value || value.state === 'stopped') return 'Not loaded'
  if (value.state === 'error') return 'Engine stopped'
  if (value.state === 'loading') return 'Loading model…'
  if (!value.backend) return 'Backend not confirmed'
  return [value.backend, value.device].filter(Boolean).join(' · ')
}

/** Match catalog IDs or a model's exact primary filename; never borrow another model's state. */
export function modelRuntimeBackend(
  values: RuntimeBackend[],
  id: RuntimeId,
  models: string[]
): RuntimeBackend | undefined {
  return (
    values.find(
      (value) =>
        value.id === id &&
        value.model &&
        models.some(
          (model) =>
            value.model === model || value.model!.replace(/\\/g, '/').split('/').at(-1) === model
        )
    ) ?? values.find((value) => value.id === id && value.state === 'unavailable')
  )
}
