/** Live model placement. Availability and model selection are separate from residency. */
export type RuntimeId =
  'chat' | 'image' | 'speech' | 'transcription' | 'embeddings' | 'grounding' | 'decision'
export interface RuntimeBackend {
  id: RuntimeId
  model?: string
  state: 'loading' | 'loaded' | 'stopped' | 'error' | 'unavailable'
  backend?: string
  device?: string
  detail?: string
  fallbackReason?: string
  lastError?: string
  /** Layers on the GPU and in the model, when the engine reports them. */
  gpuLayers?: number
  totalLayers?: number
  /** For an engine that loads per job: what it last ran on. */
  lastRun?: { backend?: string; device?: string; at: number }
  /** While loading: when the load began. */
  loadingSince?: number
}

export type RuntimeStatusTone = 'ok' | 'warn' | 'error' | 'idle'

function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`
}

/**
 * The one line Settings shows for an engine: what it runs on, why it fell back, or why it stopped.
 * A CUDA engine's first load compiles GPU kernels for minutes; that wait is named, not hidden.
 */
export function runtimeBackendStatus(
  value: RuntimeBackend | undefined,
  now = Date.now()
): { text: string; tone: RuntimeStatusTone; reason?: string } {
  if (value?.state === 'unavailable') return { text: 'Status unavailable', tone: 'idle' }
  if (value?.state === 'error') {
    return {
      text: 'Stopped',
      tone: 'error',
      reason: value.lastError ?? value.detail ?? 'The engine stopped.'
    }
  }
  if (value?.state === 'loading') {
    const slow = value.loadingSince !== undefined && now - value.loadingSince > 20_000
    return { text: slow ? 'Preparing the GPU (first time only)…' : 'Loading model…', tone: 'idle' }
  }
  if (!value || value.state === 'stopped') {
    const last = value?.lastRun
    if (!last?.backend) return { text: 'Not loaded', tone: 'idle' }
    const where = [last.device, last.backend].filter(Boolean).join(' · ')
    return { text: `Last run: ${where} · ${ago(last.at, now)}`, tone: 'idle' }
  }
  if (!value.backend) return { text: 'Backend not confirmed', tone: 'idle' }
  const layers =
    value.gpuLayers !== undefined && value.totalLayers
      ? value.gpuLayers >= value.totalLayers
        ? 'all layers on GPU'
        : value.gpuLayers > 0
          ? `${value.gpuLayers} of ${value.totalLayers} layers on GPU`
          : undefined
      : undefined
  const text = [value.device, value.backend, layers].filter(Boolean).join(' · ')
  const fellBack = /^CPU\b/i.test(value.backend) && !!value.fallbackReason
  return fellBack ? { text, tone: 'warn', reason: value.fallbackReason } : { text, tone: 'ok' }
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
