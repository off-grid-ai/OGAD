/**
 * Unit tests for the pure TTS helpers extracted from tts.ts: voice selection,
 * teardown-noise classification, and the resident-worker NDJSON line parse.
 * No child_process/electron — pure import-and-assert.
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SPEECH_VOICE,
  isSpeechRuntimeTeardownNoise,
  parseSpeechProgress,
  parseSpeechVoiceCatalog,
  parseSpeechWorkerMessage,
  resolveSpeechVoice
} from '@offgrid/models'

// Note: markdown -> speakable text moved to the renderer (src/renderer/.../speakable.ts),
// which parses with the chat UI's real markdown AST. Its tests live beside it. This
// service no longer parses markdown (SRP: it synthesizes plain text), so there is no
// toSpeakableText here to test.

describe('resolveSpeechVoice — explicit > valid stored selection > default', () => {
  it("caller's explicit voice always wins", () => {
    expect(resolveSpeechVoice({ requested: 'am_michael', selected: 'af_bella' })).toBe('am_michael')
    expect(resolveSpeechVoice({ requested: 'am_michael', selected: 'not-a-voice-id' })).toBe(
      'am_michael'
    )
    expect(resolveSpeechVoice({ requested: 'am_michael', selected: null })).toBe('am_michael')
  })

  it('a valid stored selection (xx_name shape) is used when no explicit voice', () => {
    expect(resolveSpeechVoice({ selected: 'af_heart' })).toBe('af_heart')
    expect(resolveSpeechVoice({ selected: 'am_michael' })).toBe('am_michael')
    // case-insensitive on the two-letter lang + name
    expect(resolveSpeechVoice({ selected: 'AF_Heart' })).toBe('AF_Heart')
  })

  it('an invalid stored selection (a model id, not a voice) falls back to default', () => {
    expect(resolveSpeechVoice({ selected: 'kokoro-82m' })).toBe(DEFAULT_SPEECH_VOICE)
    expect(resolveSpeechVoice({ selected: 'gemma-3n' })).toBe(DEFAULT_SPEECH_VOICE)
    expect(resolveSpeechVoice({ selected: 'af' })).toBe(DEFAULT_SPEECH_VOICE) // no _name segment
  })

  it('no voice and no selection → default', () => {
    expect(resolveSpeechVoice({ selected: null })).toBe(DEFAULT_SPEECH_VOICE)
    expect(resolveSpeechVoice({ selected: undefined })).toBe(DEFAULT_SPEECH_VOICE)
    expect(resolveSpeechVoice({ requested: '', selected: null })).toBe(DEFAULT_SPEECH_VOICE)
  })
})

describe('isSpeechRuntimeTeardownNoise — the harmless onnxruntime teardown crash', () => {
  it('matches the known teardown crash strings', () => {
    expect(isSpeechRuntimeTeardownNoise('mutex lock failed')).toBe(true)
    expect(isSpeechRuntimeTeardownNoise('Session already disposed')).toBe(true)
    expect(isSpeechRuntimeTeardownNoise('libc++abi: terminating')).toBe(true)
    expect(isSpeechRuntimeTeardownNoise('MUTEX LOCK FAILED')).toBe(true) // case-insensitive
  })

  it('does not match a real error', () => {
    expect(isSpeechRuntimeTeardownNoise('unknown model architecture')).toBe(false)
    expect(isSpeechRuntimeTeardownNoise('')).toBe(false)
  })
})

describe('parseSpeechWorkerMessage — NDJSON line parse', () => {
  it('parses a valid JSON line', () => {
    expect(parseSpeechWorkerMessage('{"ready":true}')).toEqual({ ready: true })
    expect(parseSpeechWorkerMessage('{"id":"3","ok":true}')).toEqual({ id: '3', ok: true })
  })

  it('trims surrounding whitespace before parsing', () => {
    expect(parseSpeechWorkerMessage('  {"ok":false,"error":"boom"}  ')).toEqual({
      ok: false,
      error: 'boom'
    })
  })

  it('a blank / whitespace-only line yields null', () => {
    expect(parseSpeechWorkerMessage('')).toBeNull()
    expect(parseSpeechWorkerMessage('   ')).toBeNull()
  })

  it('malformed JSON yields null (never throws)', () => {
    expect(parseSpeechWorkerMessage('not json')).toBeNull()
    expect(parseSpeechWorkerMessage('{ broken')).toBeNull()
  })
})

describe('parseSpeechProgress — worker download progress', () => {
  it('returns bounded percentage progress', () => {
    expect(parseSpeechProgress('OFFGRID_TTS_PROGRESS {"progress":42}')).toBe(42)
    expect(parseSpeechProgress('OFFGRID_TTS_PROGRESS {"progress":120}')).toBe(100)
    expect(parseSpeechProgress('OFFGRID_TTS_PROGRESS {"progress":-5}')).toBe(0)
  })

  it('ignores unrelated or malformed diagnostics', () => {
    expect(parseSpeechProgress('Downloading model')).toBeNull()
    expect(parseSpeechProgress('OFFGRID_TTS_PROGRESS broken')).toBeNull()
    expect(parseSpeechProgress('OFFGRID_TTS_PROGRESS {"progress":"42"}')).toBeNull()
  })
})

describe('parseSpeechVoiceCatalog — runtime language source', () => {
  it('keeps valid runtime metadata and drops malformed entries', () => {
    expect(
      parseSpeechVoiceCatalog(
        JSON.stringify([
          { id: 'af_heart', label: 'Heart', language: 'en-US' },
          { id: 'jf_tebukuro', label: 'Tebukuro', language: 'ja' },
          { label: 'Missing id', language: 'en-US' }
        ])
      )
    ).toEqual([
      { id: 'af_heart', label: 'Heart', language: 'en-US' },
      { id: 'jf_tebukuro', label: 'Tebukuro', language: 'ja' }
    ])
  })

  it('returns an empty catalogue for malformed output', () => {
    expect(parseSpeechVoiceCatalog('not json')).toEqual([])
  })
})
