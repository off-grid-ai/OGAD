import { describe, it, expect } from 'vitest'
import {
  formatContextWindow,
  formatParams,
  isModelWeightFile,
  modelFileGuidance,
  resolveActiveTextModel
} from '../model-summary'
import { modelDisplayName } from '@offgrid/models'

describe('model file guidance', () => {
  const file = (
    quant: string,
    gb: number
  ): {
    fileName: string
    quant: string
    sizeBytes: number
    mmproj: { sizeBytes: number }
  } => ({
    fileName: `Qwen3.6-35B-A3B-UD-${quant}.gguf`,
    quant: 'Unknown',
    sizeBytes: gb * 1e9,
    mmproj: { sizeBytes: 0.5e9 }
  })
  const variants = [
    file('IQ1_M', 11.4),
    file('IQ3_S', 15.3),
    file('Q4_K_M', 22.7),
    file('Q8_K_XL', 39.1)
  ] as const

  it('excludes support files from the picker and recommends the smallest runnable model', () => {
    const supportFiles = [
      'imatrix_unsloth.gguf',
      'Qwen-imatrix.gguf',
      'importance_matrix.gguf',
      'mmproj-F16.gguf'
    ].map((fileName) => ({ ...file('Q4_K_M', 0.014), fileName, quant: 'Unknown' }))
    const listed = [...variants, ...supportFiles].filter(isModelWeightFile)
    expect(listed.map((entry) => entry.fileName)).toEqual(variants.map((entry) => entry.fileName))
    const guidance = modelFileGuidance([...variants, ...supportFiles], 64)
    for (const support of supportFiles) expect(guidance.has(support.fileName)).toBe(false)
    expect(guidance.get(variants[0].fileName)?.labels).toContain('Smallest download')
  })

  it('keeps custom model filenames but does not rank unknown precision as the smallest model', () => {
    const custom = { ...file('Q4_K_M', 0.014), fileName: 'my-model.gguf', quant: 'Unknown' }
    expect(isModelWeightFile(custom)).toBe(true)
    expect(isModelWeightFile({ fileName: 'config.json' })).toBe(false)
    const guidance = modelFileGuidance([...variants, custom], 64)
    expect(guidance.get(custom.fileName)?.labels).toEqual([])
    expect(guidance.get(variants[0].fileName)?.labels).toContain('Smallest download')
  })

  it('changes the balance choice with reported RAM, without an OS assumption', () => {
    const smallerDevice = modelFileGuidance(variants, 48)
    const largerDevice = modelFileGuidance(variants, 64)
    expect(smallerDevice.get(variants[1].fileName)?.labels).toContain('Best balance')
    expect(largerDevice.get(variants[2].fileName)?.labels).toContain('Best balance')
    expect(smallerDevice.get(variants[2].fileName)?.labels).not.toContain('Best balance')
    expect(largerDevice.get(variants[3].fileName)?.labels).toContain('Highest precision')
    expect(largerDevice.get(variants[0].fileName)?.labels).toContain('Smallest download')
  })

  it('does not recommend a file when RAM is unknown or no moderate-precision file fits', () => {
    for (const ram of [null, 0, NaN, 16]) {
      const guidance = modelFileGuidance(variants, ram)
      expect([...guidance.values()].flatMap((row) => row.labels)).not.toContain('Best balance')
    }
    expect(modelFileGuidance(variants, 16).get(variants[2].fileName)?.fit).toBe('risky')
  })

  it('uses the full split model size and does not recommend an individual part', () => {
    const parts = [
      { ...file('BF16', 49.9), fileName: 'Qwen3.6-35B-A3B-BF16-00001-of-00002.gguf' },
      { ...file('BF16', 21.2), fileName: 'Qwen3.6-35B-A3B-BF16-00002-of-00002.gguf' }
    ] as const
    const guidance = modelFileGuidance([...variants, ...parts], 64)
    for (const part of parts) {
      expect(guidance.get(part.fileName)?.weightBytes).toBe(71.1e9)
      expect(guidance.get(part.fileName)?.fit).toBe('risky')
      expect(guidance.get(part.fileName)?.labels).toEqual(['Highest precision'])
    }
    expect(modelFileGuidance([parts[1]], 64).get(parts[1].fileName)?.fit).toBeNull()
  })

  it('does not infer memory fit from an unknown weight or companion size', () => {
    for (const variant of [
      file('Q4_K_M', 0),
      file('Q4_K_M', NaN),
      { ...file('Q4_K_M', 10), mmproj: {} }
    ]) {
      const guidance = modelFileGuidance([variant], 64).get(variant.fileName)
      expect(guidance?.fit).toBeNull()
      expect(guidance?.labels).not.toContain('Best balance')
      expect(guidance?.labels).not.toContain('Smallest download')
    }
    expect(modelFileGuidance([], 64).size).toBe(0)
  })
})

describe('formatContextWindow', () => {
  it('formats power-of-two token windows as compact K labels', () => {
    expect(formatContextWindow(4096)).toBe('4K')
    expect(formatContextWindow(8192)).toBe('8K')
    expect(formatContextWindow(32768)).toBe('32K')
    expect(formatContextWindow(131072)).toBe('128K')
  })

  it('shows small windows verbatim and omits unknown/zero', () => {
    expect(formatContextWindow(512)).toBe('512')
    expect(formatContextWindow(0)).toBeNull()
    expect(formatContextWindow(undefined)).toBeNull()
    expect(formatContextWindow(null)).toBeNull()
  })
})

// The screen helpers resolveModelName and modelNameForFile gave way to the shared resolver; the
// cases they covered still hold for the names desktop screens show.
describe('model names on desktop screens', () => {
  const models = [
    { id: 'qwen3-vl-2b', name: 'Qwen3-VL 2B' },
    { id: 'gemma-4-e2b', name: 'Gemma 4 E2B' }
  ]

  it('maps an active id to its display name', () => {
    expect(modelDisplayName('qwen3-vl-2b', { catalog: models })).toBe('Qwen3-VL 2B')
  })

  it('reads an unknown model as a name, and no model as null', () => {
    expect(modelDisplayName('just-imported.gguf', { catalog: models })).toBe('Just imported')
    expect(modelDisplayName(null, { catalog: models })).toBeNull()
    expect(modelDisplayName(undefined, { catalog: models })).toBeNull()
  })

  it('names a remote model by its provider model, never the internal routing id', () => {
    expect(
      modelDisplayName('remote-vision:0e535f87-8fff-4fa3-a8bf-6da96e4a6ac4:qwen%2Fqwen-image-3')
    ).toBe('Qwen image 3')
  })

  it('names a catalogued image model file by its catalog name, from a file name or a path', () => {
    expect(modelDisplayName('dreamshaper-xl-v2-turbo-Q8_0.gguf')).toBe(
      'DreamShaper XL v2 Turbo (versatile)'
    )
    expect(modelDisplayName('/Users/a/models/image/dreamshaper-xl-v2-turbo-Q8_0.gguf')).toBe(
      'DreamShaper XL v2 Turbo (versatile)'
    )
  })

  it('reads a file the catalog does not know as a cleaned name', () => {
    expect(modelDisplayName('my-own-merge.gguf')).toBe('My own merge')
    expect(modelDisplayName('')).toBeNull()
  })
})

describe('resolveActiveTextModel', () => {
  const models = [
    { id: 'gemma', name: 'Gemma 4 E4B' },
    {
      id: 'remote:openrouter:stealth/ox-alpha',
      name: 'stealth/ox-alpha',
      remoteServerId: 'openrouter'
    }
  ]

  it('projects the active remote text model over the loaded local model', () => {
    expect(
      resolveActiveTextModel(
        models,
        'gemma',
        new Set(['gemma', 'remote:openrouter:stealth/ox-alpha'])
      )
    ).toEqual({ name: 'Ox alpha', remote: true })
  })

  it('names a local model the list does not hold by the shared resolver, never by its file', () => {
    expect(resolveActiveTextModel(models, 'ggml-large-v3-turbo.bin', new Set())).toEqual({
      name: 'Whisper Large v3 Turbo',
      remote: false
    })
    expect(resolveActiveTextModel(models, 'my-own-merge-Q4_K_M.gguf', new Set())).toEqual({
      name: 'My own merge',
      remote: false
    })
  })

  it('uses the local model when no remote text model is active', () => {
    expect(resolveActiveTextModel(models, 'gemma', new Set(['gemma']))).toEqual({
      name: 'Gemma 4 E4B',
      remote: false
    })
  })

  it('keeps the local text selection when remote media and task models are active', () => {
    const otherModels = ['voice', 'speech', 'image', 'transcription', 'computer_use'].map(
      (kind) => ({ id: `remote:${kind}`, name: `Remote ${kind}`, kind, remoteServerId: 'server' })
    )
    expect(
      resolveActiveTextModel(
        [{ id: 'qwen', name: 'Qwen 3.5 9B', kind: 'text' }, ...otherModels],
        'qwen',
        new Set(['qwen', ...otherModels.map((model) => model.id)])
      )
    ).toEqual({ name: 'Qwen 3.5 9B', remote: false })
  })

  it.each(['text', 'vision'])('selects remote %s rather than an active voice model', (kind) => {
    expect(
      resolveActiveTextModel(
        [
          { id: 'tts', name: 'Qwen Audio TTS', kind: 'voice', remoteServerId: 'server' },
          { id: 'chat', name: 'Remote chat', kind, remoteServerId: 'server' }
        ],
        'qwen',
        new Set(['tts', 'chat'])
      )
    ).toEqual({ name: 'Remote chat', remote: true })
  })
})

describe('formatParams', () => {
  it('reads a sub-billion model in millions and larger ones in billions', () => {
    expect(formatParams(0.082)).toBe('82M')
    expect(formatParams(7)).toBe('7B')
    expect(formatParams(1.5)).toBe('1.5B')
  })
})
