import { describe, expect, it } from 'vitest'
import {
  bestSettingsFingerprint,
  isSpeedSettingsPatch,
  matchesBestSettings,
  planBestSettings,
  type MachineProfile
} from '../best-settings'

const appleM5: MachineProfile = {
  platform: 'darwin',
  cpuModel: 'Apple M5',
  performanceCores: 4,
  totalRamGb: 32,
  gpu: 'Metal'
}
const qwen9b = { weightsGb: 6.4, supportsMtp: true, modelMaxCtx: 262_144 }

describe('planBestSettings', () => {
  it('runs everything on Metal with MTP, a full-precision cache and warm engines on a 32 GB Mac', () => {
    const plan = planBestSettings(appleM5, qwen9b)

    expect(plan.chat).toEqual({
      gpuLayers: 99,
      flashAttn: true,
      kvCacheType: 'f16',
      ctxSize: 16_384,
      threads: 0,
      speculativeDecoding: 'mtp',
      speculativeDraftMax: 2,
      draftModel: ''
    })
    expect(Object.values(plan.backends)).toEqual(Array(7).fill('metal'))
    expect(plan.residency).toEqual({
      image: 'resident',
      stt: 'resident',
      tts: 'resident',
      embeddings: 'resident'
    })
    expect(plan.screenshotSize).toBe('balanced')
    expect(plan.summary[0]).toBe(
      'Chat and vision run on the Apple M5 GPU (Metal) with every layer offloaded, MTP with 2 draft tokens, a full-precision (f16) cache and a 16K context.'
    )
    expect(plan.summary[2]).toBe(
      'Kept ready in memory: image generation, transcription, voice, search.'
    )
  })

  it('uses CUDA for the native engines and DirectML for ONNX models on a Windows NVIDIA PC', () => {
    const plan = planBestSettings(
      {
        platform: 'win32',
        cpuModel: 'AMD Ryzen 9',
        performanceCores: 8,
        totalRamGb: 64,
        gpu: 'CUDA'
      },
      qwen9b
    )

    expect(plan.backends).toEqual({
      llm: 'cuda',
      image: 'cuda',
      stt: 'cuda',
      tts: 'directml',
      grounding: 'cuda',
      decision: 'cuda',
      embeddings: 'directml'
    })
  })

  it('keeps choices the platform does not offer on Auto for a Linux Vulkan GPU', () => {
    const plan = planBestSettings(
      {
        platform: 'linux',
        cpuModel: 'Intel Core i7',
        performanceCores: 6,
        totalRamGb: 16,
        gpu: 'Vulkan'
      },
      qwen9b
    )

    expect(plan.backends.llm).toBe('vulkan')
    expect(plan.backends.stt).toBe('vulkan')
    expect(plan.backends.tts).toBe('auto')
    expect(plan.backends.embeddings).toBe('auto')
    expect(plan.residency).toEqual({ stt: 'resident', tts: 'resident', embeddings: 'resident' })
  })

  it('runs on the performance cores and quantizes the cache when there is no GPU and little memory', () => {
    const plan = planBestSettings(
      {
        platform: 'linux',
        cpuModel: 'Intel Core i5',
        performanceCores: 4,
        totalRamGb: 8,
        gpu: null
      },
      { weightsGb: 2.5, supportsMtp: false, modelMaxCtx: 32_768 }
    )

    expect(plan.chat).toMatchObject({
      gpuLayers: 0,
      threads: 4,
      kvCacheType: 'q4_0',
      speculativeDecoding: 'off',
      speculativeDraftMax: 0
    })
    expect(Object.values(plan.backends)).toEqual(Array(7).fill('auto'))
    expect(plan.residency).toEqual({})
    expect(plan.summary[0]).toContain('4 CPU threads')
  })

  it('fits Bonsai 2 27B on a 16 GB Mac by halving the cache', () => {
    const plan = planBestSettings(
      { ...appleM5, totalRamGb: 16 },
      { weightsGb: 7.5, supportsMtp: false, modelMaxCtx: 262_144 }
    )

    expect(plan.chat.kvCacheType).toBe('q8_0')
    expect(plan.chat.ctxSize).toBe(16_384)
    expect(plan.chat.speculativeDecoding).toBe('off')
  })

  it('never asks for more context than the model was trained on', () => {
    const plan = planBestSettings(appleM5, { ...qwen9b, modelMaxCtx: 8_192 })

    expect(plan.chat.ctxSize).toBe(8_192)
  })

  it('reports the plan as applied only when every chosen setting is in place', () => {
    const plan = planBestSettings(appleM5, qwen9b)
    const current = {
      chat: { ...plan.chat, draftModel: undefined, temperature: 0.7 },
      backends: plan.backends,
      residency: { ...plan.residency, llm: 'resident' },
      screenshotSize: 'balanced'
    }

    expect(matchesBestSettings(plan, current)).toBe(true)
    expect(
      matchesBestSettings(plan, { ...current, chat: { ...current.chat, kvCacheType: 'q4_0' } })
    ).toBe(false)
    expect(
      matchesBestSettings(plan, { ...current, backends: { ...plan.backends, llm: 'cpu' } })
    ).toBe(false)
    expect(matchesBestSettings(plan, { ...current, residency: {} })).toBe(false)
    expect(matchesBestSettings(plan, { ...current, screenshotSize: 'large' })).toBe(false)
  })
})

describe('isSpeedSettingsPatch', () => {
  it('counts engine and memory changes but not answer or sampling changes', () => {
    expect(isSpeedSettingsPatch({ kvCacheType: 'q8_0' })).toBe(true)
    expect(isSpeedSettingsPatch({ speculativeDecoding: 'off' })).toBe(true)
    expect(isSpeedSettingsPatch({ performanceMode: 'extreme' })).toBe(true)
    expect(isSpeedSettingsPatch({ temperature: 0.4, topK: 20 })).toBe(false)
  })
})

describe('bestSettingsFingerprint', () => {
  it('changes when the GPU or the chat model changes', () => {
    const base = bestSettingsFingerprint(appleM5, 'Qwen3.5-9B-Q4_K_M.gguf')

    expect(bestSettingsFingerprint(appleM5, 'Qwen3.5-9B-Q4_K_M.gguf')).toBe(base)
    expect(bestSettingsFingerprint(appleM5, 'Ternary-Bonsai-2-27B-PQ2_0.gguf')).not.toBe(base)
    expect(bestSettingsFingerprint({ ...appleM5, gpu: null }, 'Qwen3.5-9B-Q4_K_M.gguf')).not.toBe(
      base
    )
  })
})
