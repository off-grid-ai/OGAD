import type { RuntimeBackend, RuntimeId } from '../shared/runtime-backends'
import { currentAIRequest } from './ai-request-log'

const live = new Map<RuntimeId, RuntimeBackend>()

/** Observes model loads for opt-in usage statistics: when one starts, and how it ended. */
export interface RuntimeLoadObserver {
  started(load: {
    id: RuntimeId
    model: string
  }): (
    outcome:
      | { state: 'loaded'; backend?: string }
      | { state: 'error'; error: unknown }
      | { state: 'stopped' }
  ) => void
}
let loadObserver: RuntimeLoadObserver | undefined
/** A load superseded by a newer one for the same runtime ends as stopped. */
const unsettledLoads = new Map<RuntimeId, () => void>()

export function setRuntimeLoadObserver(next: RuntimeLoadObserver | undefined): void {
  loadObserver = next
}

export function runtimeBackendSnapshot(): RuntimeBackend[] {
  return [...live.values()].map((value) => ({ ...value }))
}

/** A process-scoped lease prevents late output/exit from replacing a newer model. */
export function beginRuntimeBackend(
  id: RuntimeId,
  model: string
): {
  recordRequest: (request?: ReturnType<typeof currentAIRequest>) => void
  ready: (backend?: string, device?: string, detail?: string) => void
  observe: (chunk: string, loaded?: boolean) => void
  stop: () => void
  fail: (error: unknown) => void
} {
  // A crash is kept until the next successful load, and an engine that loads per job keeps
  // what it last ran on, so the next attempt does not wipe either from Settings.
  const previous = live.get(id)
  const record: RuntimeBackend = {
    id,
    model,
    state: 'loading',
    loadingSince: Date.now(),
    ...(previous?.lastError ? { lastError: previous.lastError } : {}),
    ...(previous?.lastRun ? { lastRun: previous.lastRun } : {})
  }
  const startingRequest = currentAIRequest()
  live.set(id, record)
  unsettledLoads.get(id)?.()
  let settle: ReturnType<RuntimeLoadObserver['started']> | undefined
  try {
    settle = loadObserver?.started({ id, model })
  } catch {
    /* Statistics must never break a load. */
  }
  const supersede = (): void => {
    const done = settle
    settle = undefined
    if (unsettledLoads.get(id) === supersede) unsettledLoads.delete(id)
    try {
      done?.({ state: 'stopped' })
    } catch {
      /* Statistics must never break a load. */
    }
  }
  if (settle) unsettledLoads.set(id, supersede)
  const update = (value: Partial<RuntimeBackend>): void => {
    if (live.get(id) === record && record.state !== 'stopped' && record.state !== 'error') {
      const wasLoading = record.state === 'loading'
      Object.assign(record, value)
      startingRequest?.useRuntime(record)
      // Re-read after the assignment: the guard above narrowed the type of the old value.
      const state = (record as RuntimeBackend).state as RuntimeBackend['state']
      if (wasLoading && state !== 'loading' && settle) {
        const done = settle
        settle = undefined
        if (unsettledLoads.get(id) === supersede) unsettledLoads.delete(id)
        try {
          done(
            state === 'loaded'
              ? { state: 'loaded', ...(record.backend ? { backend: record.backend } : {}) }
              : state === 'error'
                ? { state: 'error', error: record.detail }
                : { state: 'stopped' }
          )
        } catch {
          /* Statistics must never break a load. */
        }
      }
    }
  }
  let output = ''
  return {
    /** Capture this process, not whichever process is currently in the global list. */
    recordRequest: (request = currentAIRequest()): void => {
      request?.useRuntime(record)
    },
    ready: (backend?: string, device?: string, detail?: string): void => {
      update({
        state: 'loaded',
        loadingSince: undefined,
        lastError: undefined,
        ...(backend ? { backend } : {}),
        ...(device ? { device } : {}),
        ...(detail ? { detail, fallbackReason: detail } : { fallbackReason: undefined })
      })
    },
    observe: (chunk: string, loaded = false): void => {
      output = (output + chunk).slice(-65536)
      const placement = parseNativeBackend(output)
      if (placement) update({ ...placement, ...(loaded ? { state: 'loaded' as const } : {}) })
    },
    stop: (): void =>
      update({
        state: 'stopped',
        loadingSince: undefined,
        ...(record.backend
          ? { lastRun: { backend: record.backend, device: record.device, at: Date.now() } }
          : {}),
        backend: undefined,
        device: undefined
      }),
    fail: (error: unknown): void => {
      const message = String(error instanceof Error ? error.message : error).slice(0, 1000)
      update({
        state: 'error',
        loadingSince: undefined,
        backend: undefined,
        device: undefined,
        detail: message,
        lastError: message
      })
    }
  }
}

/** Only allocation/selection messages count. A device list or compiled feature does not. */
export function parseNativeBackend(
  output: string
): Pick<RuntimeBackend, 'backend' | 'device'> | undefined {
  const explicit = /OFFGRID_BACKEND:(Core ML|Metal|CPU)\b/.exec(output)?.[1]
  if (explicit) return { backend: explicit }
  const allocated = new Set<string>()
  const selected = new Set<string>()
  const normalize = (raw: string): string => {
    const name = raw.toLowerCase()
    return name.startsWith('cuda')
      ? 'CUDA'
      : name.startsWith('vulkan')
        ? 'Vulkan'
        : name === 'metal' || name.startsWith('mtl')
          ? 'Metal'
          : 'CPU'
  }
  for (const match of output.matchAll(
    /\b(CUDA\d*(?:_[A-Za-z]+)?|Vulkan\d*(?:_[A-Za-z]+)?|MTL\d*(?:_[A-Za-z]+)?|Metal|CPU(?:_[A-Za-z]+)?)\s+(?:(?:total\s+)?(?:model\s+)?buffer|total)\s+size\s*=\s*([\d.]+)/gi
  )) {
    if (Number(match[2]) > 0) allocated.add(normalize(match[1]!))
  }
  for (const match of output.matchAll(
    /offload params\s*\([^)]*\)\s*to runtime backend\s*\((CUDA\d*|Vulkan\d*|Metal|CPU)\)/gi
  )) {
    allocated.add(normalize(match[1]!))
  }
  if (/ggml_metal_add_buffer:\s*allocated\b/i.test(output)) allocated.add('Metal')
  for (const match of output.matchAll(
    /(?:using\s+(CUDA\d*|Vulkan\d*|Metal|CPU)\s+backend|backend\s*=\s*(CUDA\d*|Vulkan\d*|Metal|CPU)\b)/gi
  )) {
    selected.add(normalize(match[1] || match[2] || ''))
  }
  // New sd.cpp releases report the selected Metal device during context
  // allocation. Device enumeration alone does not confirm a loaded backend.
  const metalDevice = /ggml_metal_init:\s*picking default device:\s*([^\r\n]+)/i.exec(output)?.[1]?.trim()
  if (metalDevice && /ggml_metal_init:\s*allocating\b/i.test(output)) selected.add('Metal')
  const used = allocated.size ? allocated : selected
  for (const failed of output.matchAll(
    /failed to initialize (CUDA\d*|Vulkan\d*|Metal|CPU) backend/gi
  )) {
    used.delete(normalize(failed[1]!))
  }
  if (!used.size) return undefined
  const backend = [...used]
    .sort((a, b) => (a === 'CPU' ? 1 : b === 'CPU' ? -1 : a.localeCompare(b)))
    .join(' + ')
  const device = /using device\s+(?:CUDA\d*|Vulkan\d*|Metal)\s*\(([^)]+)\)/i.exec(output)?.[1]
  const selectedDevice = device ?? (used.has('Metal') ? metalDevice : undefined)
  return { backend, ...(selectedDevice ? { device: selectedDevice } : {}) }
}

export function providerLabel(device: string): string {
  return (
    (
      {
        cuda: 'CUDA',
        dml: 'DirectML',
        coreml: 'Core ML',
        webgpu: 'WebGPU',
        cpu: 'CPU',
        wasm: 'CPU (WASM)',
        mps: 'Metal'
      } as Record<string, string>
    )[device] ?? device
  )
}
