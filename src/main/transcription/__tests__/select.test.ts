import { describe, it, expect, vi } from 'vitest'
import {
  pickTranscription,
  engineForActiveModel,
  effectiveEngine,
  residentAwareEngine,
  resolveTranscription,
  catalogEngine,
  modelsByEngine,
  transcriptionProvenance,
  transcriptionModelOptions,
  resolveConfiguredTranscriptionLanguage,
  withConfiguredTranscriptionLanguage
} from '../select'
import type { TranscriptionService } from '../types'

const svc = (available: boolean, tag: string): TranscriptionService => ({
  isAvailable: () => available,
  transcribe: async () => ({ text: tag })
})

const three = (
  w: boolean,
  p: boolean,
  r: boolean
): {
  whisper: TranscriptionService
  parakeet: TranscriptionService
  whisperResident: TranscriptionService
} => ({
  whisper: svc(w, 'w'),
  parakeet: svc(p, 'p'),
  whisperResident: svc(r, 'r')
})

describe('pickTranscription', () => {
  it('uses whisper by default', () => {
    const r = pickTranscription('whisper', three(true, true, true))
    expect(r.engine).toBe('whisper')
    expect(r.fellBack).toBe(false)
  })

  it('uses Parakeet when requested and available', () => {
    const r = pickTranscription('parakeet', three(true, true, false))
    expect(r.engine).toBe('parakeet')
    expect(r.fellBack).toBe(false)
  })

  it('falls back to whisper when Parakeet is requested but not installed', () => {
    const r = pickTranscription('parakeet', three(true, false, false))
    expect(r.engine).toBe('whisper')
    expect(r.fellBack).toBe(true)
  })

  it('uses the resident whisper-server when requested and available', () => {
    const r = pickTranscription('whisper-resident', three(true, false, true))
    expect(r.engine).toBe('whisper-resident')
    expect(r.fellBack).toBe(false)
  })

  it('degrades to one-shot whisper when whisper-resident is requested but not built', () => {
    const r = pickTranscription('whisper-resident', three(true, false, false))
    expect(r.engine).toBe('whisper')
    expect(r.fellBack).toBe(true)
  })

  it('never falls back for a whisper request even if whisper reports unavailable', () => {
    // whisper is the terminal fallback; selection doesn't second-guess it here.
    const r = pickTranscription('whisper', three(false, true, true))
    expect(r.engine).toBe('whisper')
    expect(r.fellBack).toBe(false)
  })
})

describe('withConfiguredTranscriptionLanguage', () => {
  it('applies the selected language to normal transcription', async () => {
    const transcribe = vi.fn(async () => ({ text: 'bonjour' }))
    const configured = withConfiguredTranscriptionLanguage(
      { isAvailable: () => true, transcribe },
      'fr'
    )

    await configured.transcribe({ path: '/tmp/voice.wav' })

    expect(transcribe).toHaveBeenCalledWith(
      { path: '/tmp/voice.wav' },
      expect.objectContaining({ language: 'fr' })
    )
  })

  it('allows a specialized caller to override the selected language', async () => {
    const transcribe = vi.fn(async () => ({ text: 'hello' }))
    const configured = withConfiguredTranscriptionLanguage(
      { isAvailable: () => true, transcribe },
      'fr'
    )

    await configured.transcribe({ path: '/tmp/voice.wav' }, { language: 'en' })

    expect(transcribe).toHaveBeenCalledWith(
      { path: '/tmp/voice.wav' },
      expect.objectContaining({ language: 'en' })
    )
  })
})

describe('resolveConfiguredTranscriptionLanguage', () => {
  const languages = [
    { code: 'auto', label: 'Auto-detect' },
    { code: 'hi', label: 'Hindi' }
  ]

  it('keeps a language supported by the selected transcription model', () => {
    expect(resolveConfiguredTranscriptionLanguage('hi', languages)).toBe('hi')
  })

  it('falls back to the model default after switching to an incompatible model', () => {
    expect(resolveConfiguredTranscriptionLanguage('fr', languages)).toBe('auto')
    expect(resolveConfiguredTranscriptionLanguage('fr', [])).toBe('auto')
  })
})

describe('engineForActiveModel', () => {
  const entries = [
    { id: 'ggml-base', files: [{ name: 'ggml-base.bin' }] }, // whisper (no engine field)
    {
      id: 'csukuangfj/parakeet-v2',
      engine: 'parakeet' as const,
      files: [{ name: 'parakeet-v2.encoder.int8.onnx' }, { name: 'parakeet-v2.tokens.txt' }]
    }
  ]

  it('defaults to whisper when nothing is active', () => {
    expect(engineForActiveModel(null, entries)).toBe('whisper')
  })

  it('resolves parakeet when the active pick is the catalog id', () => {
    expect(engineForActiveModel('csukuangfj/parakeet-v2', entries)).toBe('parakeet')
  })

  it('resolves parakeet when the active pick is a primary filename (not the id)', () => {
    // active-models stores id OR filename — the filename form must still resolve.
    expect(engineForActiveModel('parakeet-v2.encoder.int8.onnx', entries)).toBe('parakeet')
  })

  it('resolves whisper for a whisper model choice', () => {
    expect(engineForActiveModel('ggml-base.bin', entries)).toBe('whisper')
  })

  it('falls back to whisper for an unknown active value', () => {
    expect(engineForActiveModel('nope', entries)).toBe('whisper')
  })
})

describe('residentAwareEngine', () => {
  it('routes a whisper choice to whisper-resident only in resident mode', () => {
    expect(residentAwareEngine('whisper', 'resident')).toBe('whisper-resident')
    expect(residentAwareEngine('whisper', 'on-demand')).toBe('whisper')
  })

  it('keeps Parakeet on its one-shot CLI regardless of mode (no resident server)', () => {
    expect(residentAwareEngine('parakeet', 'resident')).toBe('parakeet')
    expect(residentAwareEngine('parakeet', 'on-demand')).toBe('parakeet')
  })
})

describe('effectiveEngine (fallback-aware labeling)', () => {
  // In the test environment the Parakeet runtime isn't installed, so a Parakeet
  // request must resolve to (and be labeled) 'whisper' — the exact provenance case.
  it('labels a whisper request as whisper', () => {
    expect(effectiveEngine('whisper')).toBe('whisper')
  })
  it('labels a Parakeet request as whisper when Parakeet is not installed', () => {
    expect(effectiveEngine('parakeet')).toBe('whisper')
  })
})

describe('catalogEngine (single-source engine classification)', () => {
  it('classifies a tagged parakeet entry as parakeet', () => {
    expect(catalogEngine({ engine: 'parakeet' })).toBe('parakeet')
  })
  it('classifies an untagged entry as whisper (whisper is the untagged default)', () => {
    expect(catalogEngine({})).toBe('whisper')
    expect(catalogEngine({ engine: undefined })).toBe('whisper')
  })
  it('classifies an unknown engine string as whisper (only parakeet is tagged)', () => {
    expect(catalogEngine({ engine: 'something-else' })).toBe('whisper')
  })
  it('treats null/undefined entry as whisper', () => {
    expect(catalogEngine(null)).toBe('whisper')
    expect(catalogEngine(undefined)).toBe('whisper')
  })
})

describe('modelsByEngine (catalog partition by engine)', () => {
  const entries = [
    { id: 'ggml-base', files: [{ name: 'ggml-base.bin' }] }, // untagged -> whisper
    { id: 'ggml-small', engine: undefined, files: [{ name: 'ggml-small.bin' }] },
    { id: 'pk/v2', engine: 'parakeet', files: [{ name: 'pk-v2.encoder.onnx' }] },
    { id: 'pk/v3', engine: 'parakeet', files: [{ name: 'pk-v3.encoder.onnx' }] }
  ]

  it('returns only the parakeet-tagged entries for parakeet', () => {
    expect(modelsByEngine('parakeet', entries).map((e) => e.id)).toEqual(['pk/v2', 'pk/v3'])
  })

  it('returns every non-parakeet entry for whisper (untagged is whisper)', () => {
    expect(modelsByEngine('whisper', entries).map((e) => e.id)).toEqual(['ggml-base', 'ggml-small'])
  })

  it('the two partitions are disjoint and cover every entry', () => {
    const w = modelsByEngine('whisper', entries).map((e) => e.id)
    const p = modelsByEngine('parakeet', entries).map((e) => e.id)
    expect([...w, ...p].sort()).toEqual(entries.map((e) => e.id).sort())
    expect(w.some((id) => p.includes(id))).toBe(false)
  })

  it('reads the live catalog when no entries are passed (default arg)', () => {
    // Every entry the live catalog returns for an engine must actually classify as it —
    // proves the default-arg path calls through the same classifier, no re-filter.
    for (const e of modelsByEngine('parakeet')) expect(catalogEngine(e)).toBe('parakeet')
    for (const e of modelsByEngine('whisper')) expect(catalogEngine(e)).toBe('whisper')
  })
})

describe('resolveTranscription (dispatcher: residency fold + fallback)', () => {
  // Runs against the REAL service singletons. In the test env neither Parakeet nor the
  // resident whisper-server is installed, so both degrade to one-shot whisper — the exact
  // production fallback path. resolveTranscription must fold residency in FIRST, then apply
  // that same availability fallback.
  it('a plain whisper request stays whisper (no mode)', () => {
    const r = resolveTranscription('whisper')
    expect(r.engine).toBe('whisper')
    expect(r.fellBack).toBe(false)
  })

  it('on-demand mode leaves a whisper request on one-shot whisper', () => {
    const r = resolveTranscription('whisper', 'on-demand')
    expect(r.engine).toBe('whisper')
    expect(r.fellBack).toBe(false)
  })

  it('resident mode upgrades whisper toward the resident server, then degrades when it is not built', () => {
    // whisper -> whisper-resident (residency fold) -> whisper (availability fallback).
    const r = resolveTranscription('whisper', 'resident')
    expect(r.engine).toBe('whisper')
    expect(r.fellBack).toBe(true)
  })

  it('resident mode does NOT upgrade a Parakeet request (parakeet has no resident server)', () => {
    // parakeet stays parakeet through the fold, then degrades to whisper (not installed).
    const r = resolveTranscription('parakeet', 'resident')
    expect(r.engine).toBe('whisper')
    expect(r.fellBack).toBe(true)
  })

  it('a Parakeet request degrades to whisper when Parakeet is not installed', () => {
    const r = resolveTranscription('parakeet')
    expect(r.engine).toBe('whisper')
    expect(r.fellBack).toBe(true)
  })

  it('matches effectiveEngine for the same request (single source of the fallback)', () => {
    // resolveTranscription and effectiveEngine must agree — effectiveEngine delegates here.
    for (const e of ['whisper', 'parakeet', 'whisper-resident'] as const) {
      expect(resolveTranscription(e).engine).toBe(effectiveEngine(e))
    }
  })
})

describe('transcriptionProvenance — display label for the active STT choice', () => {
  const catalog = [
    { id: 'whisper-medium', name: 'Whisper Medium', files: [{ name: 'ggml-medium.bin' }] },
    { id: 'parakeet-06b', name: 'Parakeet 0.6B', files: [{ name: 'parakeet.onnx' }] }
  ]

  it('labels the engine + the catalog model name (matched by id)', () => {
    const info = transcriptionProvenance('whisper', 'whisper-medium', catalog)
    expect(info).toEqual({
      engine: 'whisper',
      modelId: 'whisper-medium',
      label: 'Whisper · Whisper Medium'
    })
  })

  it('matches the active model by primary FILENAME too, not just id', () => {
    expect(transcriptionProvenance('whisper', 'ggml-medium.bin', catalog).label).toBe(
      'Whisper · Whisper Medium'
    )
  })

  it("labels 'whisper-resident' as Whisper (residency is not a separate product name)", () => {
    expect(transcriptionProvenance('whisper-resident', 'whisper-medium', catalog).engine).toBe(
      'whisper-resident'
    )
    expect(transcriptionProvenance('whisper-resident', 'whisper-medium', catalog).label).toBe(
      'Whisper · Whisper Medium'
    )
  })

  it('names Parakeet when that is the effective engine', () => {
    expect(transcriptionProvenance('parakeet', 'parakeet-06b', catalog).label).toBe(
      'Parakeet · Parakeet 0.6B'
    )
  })

  it("says 'built-in' when no model is explicitly active", () => {
    const info = transcriptionProvenance('whisper', null, catalog)
    expect(info).toEqual({ engine: 'whisper', modelId: null, label: 'Whisper · built-in' })
  })

  it('falls back to the raw id when the active model is not in the catalog', () => {
    expect(transcriptionProvenance('whisper', 'mystery.bin', catalog).label).toBe(
      'Whisper · mystery.bin'
    )
  })
})


describe('transcriptionModelOptions — switchable models for the picker', () => {
  const installed = [
    { id: 'whisper-medium', name: 'Whisper Medium', files: [{ name: 'ggml-medium.bin' }] },
    { id: 'parakeet-06b', name: 'Parakeet 0.6B', files: [{ name: 'parakeet.onnx' }] }
  ]

  it('always offers the built-in whisper default first', () => {
    const opts = transcriptionModelOptions(null, [])
    expect(opts).toEqual([{ id: null, name: 'Whisper (built-in)', active: true }])
  })

  it('lists the built-in default + every installed transcription model', () => {
    const opts = transcriptionModelOptions('whisper-medium', installed)
    expect(opts.map((o) => o.name)).toEqual([
      'Whisper (built-in)',
      'Whisper Medium',
      'Parakeet 0.6B'
    ])
  })

  it('flags the active model (matched by id) and only it', () => {
    const opts = transcriptionModelOptions('whisper-medium', installed)
    expect(opts.filter((o) => o.active).map((o) => o.id)).toEqual(['whisper-medium'])
  })

  it('flags the active model matched by primary FILENAME too', () => {
    const opts = transcriptionModelOptions('parakeet.onnx', installed)
    expect(opts.find((o) => o.active)?.id).toBe('parakeet-06b')
  })

  it('marks built-in active only when nothing is explicitly selected', () => {
    expect(transcriptionModelOptions(null, installed).find((o) => o.active)?.id).toBeNull()
  })

  it('falls back to the id as the name when a catalog entry has none', () => {
    const opts = transcriptionModelOptions(null, [{ id: 'x/y', files: [{ name: 'y.bin' }] }])
    expect(opts[1]).toEqual({ id: 'x/y', name: 'x/y', active: false })
  })
})
