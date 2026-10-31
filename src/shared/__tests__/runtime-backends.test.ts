import { describe, expect, it } from 'vitest'
import {
  modelRuntimeBackend,
  runtimeBackendLabel,
  runtimeBackendStatus,
  type RuntimeBackend
} from '../runtime-backends'

describe('runtime backend display', () => {
  it('shows a useful status before and after the engine reports placement', () => {
    const value: RuntimeBackend = { id: 'chat', state: 'loading' }
    expect(runtimeBackendLabel()).toBe('Not loaded')
    expect(runtimeBackendLabel(value)).toBe('Loading model…')
    expect(runtimeBackendLabel({ ...value, state: 'loaded' })).toBe('Backend not confirmed')
    expect(
      runtimeBackendLabel({ ...value, state: 'loaded', backend: 'Metal', device: 'GPU' })
    ).toBe('Metal · GPU')
    expect(runtimeBackendLabel({ ...value, state: 'error' })).toBe('Engine stopped')
    expect(runtimeBackendLabel({ ...value, state: 'stopped' })).toBe('Not loaded')
    expect(runtimeBackendLabel({ ...value, state: 'unavailable' })).toBe('Status unavailable')
  })

  it('does not borrow a different model’s backend when the selected model is unavailable', () => {
    const values: RuntimeBackend[] = [
      { id: 'chat', model: 'other.gguf', state: 'loaded', backend: 'CUDA' },
      { id: 'chat', state: 'unavailable' },
      { id: 'image', model: 'selected.gguf', state: 'loaded', backend: 'CPU' }
    ]
    expect(modelRuntimeBackend(values, 'chat', ['selected.gguf'])).toEqual(values[1])
    values.unshift({
      id: 'chat',
      model: '/models/selected.gguf',
      state: 'loaded',
      backend: 'Metal'
    })
    expect(modelRuntimeBackend(values, 'chat', ['selected.gguf'])).toEqual(values[0])
    expect(modelRuntimeBackend(values, 'chat', ['/models/selected.gguf'])).toEqual(values[0])
  })
})

describe('the Settings status line', () => {
  const now = Date.parse('2026-10-15T12:00:00Z')
  const loaded: RuntimeBackend = {
    id: 'chat',
    state: 'loaded',
    backend: 'CUDA',
    device: 'RTX 4070'
  }

  it('names the device, the backend and how much of the model is on the GPU', () => {
    expect(runtimeBackendStatus({ ...loaded, gpuLayers: 28, totalLayers: 28 }, now)).toEqual({
      text: 'RTX 4070 · CUDA · all layers on GPU',
      tone: 'ok'
    })
    expect(runtimeBackendStatus({ ...loaded, gpuLayers: 20, totalLayers: 40 }, now).text).toBe(
      'RTX 4070 · CUDA · 20 of 40 layers on GPU'
    )
  })

  it('says why it fell back to the CPU and why an engine stopped', () => {
    expect(
      runtimeBackendStatus(
        { id: 'chat', state: 'loaded', backend: 'CPU', fallbackReason: 'No usable GPU found' },
        now
      )
    ).toEqual({ text: 'CPU', tone: 'warn', reason: 'No usable GPU found' })
    expect(
      runtimeBackendStatus({ id: 'image', state: 'error', lastError: 'Out of GPU memory' }, now)
    ).toEqual({ text: 'Stopped', tone: 'error', reason: 'Out of GPU memory' })
  })

  it('shows the last run for an engine that loads per job, and names a slow first GPU load', () => {
    expect(
      runtimeBackendStatus(
        { id: 'image', state: 'stopped', lastRun: { backend: 'Metal', at: now - 2 * 60_000 } },
        now
      ).text
    ).toBe('Last run: Metal · 2 min ago')
    expect(
      runtimeBackendStatus({ id: 'chat', state: 'loading', loadingSince: now - 30_000 }, now).text
    ).toBe('Preparing the GPU (first time only)…')
  })
})
