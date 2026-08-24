/**
 * Unit tests for the pure TTS helpers extracted from tts.ts: voice selection,
 * teardown-noise classification, and the resident-worker NDJSON line parse.
 * No child_process/electron — pure import-and-assert.
 */
import { describe, it, expect } from 'vitest'
import {
  chooseVoice,
  isTeardownNoise,
  parseRuntimeVoiceCatalog,
  parseServeLine,
  parseTtsProgressLine,
  DEFAULT_VOICE
} from '../tts-logic'

// Note: markdown -> speakable text moved to the renderer (src/renderer/.../speakable.ts),
// which parses with the chat UI's real markdown AST. Its tests live beside it. This
// service no longer parses markdown (SRP: it synthesizes plain text), so there is no
// toSpeakableText here to test.

describe('chooseVoice — explicit > valid stored selection > default', () => {
  it("caller's explicit voice always wins", () => {
    expect(chooseVoice('am_michael', 'af_bella')).toBe('am_michael')
    expect(chooseVoice('am_michael', 'not-a-voice-id')).toBe('am_michael')
    expect(chooseVoice('am_michael', null)).toBe('am_michael')
  })

  it('a valid stored selection (xx_name shape) is used when no explicit voice', () => {
    expect(chooseVoice(undefined, 'af_heart')).toBe('af_heart')
    expect(chooseVoice(undefined, 'am_michael')).toBe('am_michael')
    // case-insensitive on the two-letter lang + name
    expect(chooseVoice(undefined, 'AF_Heart')).toBe('AF_Heart')
  })

  it('an invalid stored selection (a model id, not a voice) falls back to default', () => {
    expect(chooseVoice(undefined, 'kokoro-82m')).toBe(DEFAULT_VOICE)
    expect(chooseVoice(undefined, 'gemma-3n')).toBe(DEFAULT_VOICE)
    expect(chooseVoice(undefined, 'af')).toBe(DEFAULT_VOICE) // no _name segment
  })

  it('no voice and no selection → default', () => {
    expect(chooseVoice(undefined, null)).toBe(DEFAULT_VOICE)
    expect(chooseVoice(undefined, undefined)).toBe(DEFAULT_VOICE)
    expect(chooseVoice('', null)).toBe(DEFAULT_VOICE)
  })
})

describe('isTeardownNoise — the harmless onnxruntime teardown crash', () => {
  it('matches the known teardown crash strings', () => {
    expect(isTeardownNoise('mutex lock failed')).toBe(true)
    expect(isTeardownNoise('Session already disposed')).toBe(true)
    expect(isTeardownNoise('libc++abi: terminating')).toBe(true)
    expect(isTeardownNoise('MUTEX LOCK FAILED')).toBe(true) // case-insensitive
  })

  it('does not match a real error', () => {
    expect(isTeardownNoise('unknown model architecture')).toBe(false)
    expect(isTeardownNoise('')).toBe(false)
  })
})

describe('parseServeLine — NDJSON line parse', () => {
  it('parses a valid JSON line', () => {
    expect(parseServeLine('{"ready":true}')).toEqual({ ready: true })
    expect(parseServeLine('{"id":"3","ok":true}')).toEqual({ id: '3', ok: true })
  })

  it('trims surrounding whitespace before parsing', () => {
    expect(parseServeLine('  {"ok":false,"error":"boom"}  ')).toEqual({ ok: false, error: 'boom' })
  })

  it('a blank / whitespace-only line yields null', () => {
    expect(parseServeLine('')).toBeNull()
    expect(parseServeLine('   ')).toBeNull()
  })

  it('malformed JSON yields null (never throws)', () => {
    expect(parseServeLine('not json')).toBeNull()
    expect(parseServeLine('{ broken')).toBeNull()
  })
})

describe('parseTtsProgressLine — worker download progress', () => {
  it('returns bounded percentage progress', () => {
    expect(parseTtsProgressLine('OFFGRID_TTS_PROGRESS {"progress":42}')).toBe(42)
    expect(parseTtsProgressLine('OFFGRID_TTS_PROGRESS {"progress":120}')).toBe(100)
    expect(parseTtsProgressLine('OFFGRID_TTS_PROGRESS {"progress":-5}')).toBe(0)
  })

  it('ignores unrelated or malformed diagnostics', () => {
    expect(parseTtsProgressLine('Downloading model')).toBeNull()
    expect(parseTtsProgressLine('OFFGRID_TTS_PROGRESS broken')).toBeNull()
    expect(parseTtsProgressLine('OFFGRID_TTS_PROGRESS {"progress":"42"}')).toBeNull()
  })
})

describe('parseRuntimeVoiceCatalog — runtime language source', () => {
  it('keeps valid runtime metadata and drops malformed entries', () => {
    expect(parseRuntimeVoiceCatalog(JSON.stringify([
      { id: 'af_heart', label: 'Heart', language: 'en-US' },
      { id: 'jf_tebukuro', label: 'Tebukuro', language: 'ja' },
      { label: 'Missing id', language: 'en-US' },
    ]))).toEqual([
      { id: 'af_heart', label: 'Heart', language: 'en-US' },
      { id: 'jf_tebukuro', label: 'Tebukuro', language: 'ja' },
    ])
  })

  it('returns an empty catalogue for malformed output', () => {
    expect(parseRuntimeVoiceCatalog('not json')).toEqual([])
  })
})
