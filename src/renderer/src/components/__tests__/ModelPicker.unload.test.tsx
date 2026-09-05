// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { ModelPicker } from '../ModelPicker'
import { modelControlSnapshot } from './harness/model-control-snapshot'
import { ok } from '@offgrid/application'

function stubApi(): void {
  const models = [
    {
      id: 'kokoro',
      name: 'Kokoro TTS 82M',
      kind: 'voice',
      artifacts: [{ name: 'kokoro.onnx', role: 'primary' }]
    },
    {
      id: 'whisper',
      name: 'Whisper Tiny',
      kind: 'transcription',
      artifacts: [{ name: 'whisper.bin', role: 'primary' }]
    }
  ]
  const projection = modelControlSnapshot({
    kinds: ['voice', 'transcription'],
    models,
    installed: ['kokoro', 'whisper'],
    active: { speech: 'kokoro', transcription: 'whisper' }
  })
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = {
    getModelControlProjection: async () => projection,
    controlModel: async (intent: {
      type: string
      surface?: 'speech' | 'transcription'
      operationId: string
    }) => {
      if (intent.type === 'unload' && intent.surface) {
        projection.active[intent.surface] = { ...projection.active[intent.surface], ready: false }
      }
      return ok({ status: 'completed', operationId: intent.operationId, projection })
    },
    getComputerUseActiveModels: async () => ({
      strategy: 'separate_specialist',
      strategyLabel: 'Separate specialist',
      models: []
    }),
    getModelCatalog: async () => ({
      models
    }),
    getInstalledModels: async () => ['kokoro', 'whisper'],
    getActiveModel: async () => null,
    getActiveModalities: async () => ({ speech: 'kokoro.onnx', transcription: 'whisper.bin' }),
    unloadRuntime: async () => true
  }
}

describe('ModelPicker unload — per modality, independent', () => {
  beforeEach(stubApi)
  afterEach(() => {
    cleanup()
    ;(globalThis as unknown as { window: { api: unknown } }).window.api = undefined
  })

  it('keeps each modality unloaded independently (unloading one does not reset another)', async () => {
    render(<ModelPicker onClose={() => {}} />)
    await screen.findByText('Kokoro TTS 82M')
    await screen.findByText('Whisper Tiny')

    // Two active modalities → two Unload buttons, nothing unloaded yet.
    expect(screen.getAllByRole('button', { name: 'Unload' })).toHaveLength(2)
    expect(screen.queryAllByText('Unloaded')).toHaveLength(0)

    // Unload voice → exactly one modality is now Unloaded.
    fireEvent.click(screen.getAllByRole('button', { name: 'Unload' })[0]!)
    await waitFor(() => expect(screen.getAllByText('Unloaded')).toHaveLength(1))

    // Unload transcription → BOTH stay Unloaded (the bug: it reset voice to loaded).
    fireEvent.click(screen.getAllByRole('button', { name: 'Unload' })[1]!)
    await waitFor(() => expect(screen.getAllByText('Unloaded')).toHaveLength(2))
  })
})
