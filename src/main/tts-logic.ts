// Pure TTS helpers extracted from tts.ts so they can be unit-tested without
// spawning the Kokoro worker or loading electron. Behaviour is unchanged —
// tts.ts imports these back and uses them exactly as before.

export const DEFAULT_VOICE = 'af_heart'

/** Pick the voice to synthesize with. Caller's explicit `voice` wins; else the
 *  user-selected speech voice IF it looks like a real voice name (e.g. "af_heart")
 *  and not a model id; else the default. Guards against feeding the engine an
 *  invalid voice when a model was picked in the UI. */
export function chooseVoice(voice: string | undefined, sel: string | null | undefined): string {
  return voice || (sel && /^[a-z]{2}_[a-z]+$/i.test(sel) ? sel : null) || DEFAULT_VOICE
}

/** onnxruntime's harmless teardown crash — not a real failure if output exists. */
export function isTeardownNoise(err: string): boolean {
  return /mutex lock failed|Session already disposed|libc\+\+abi/i.test(err)
}

export interface ServeMsg {
  ready?: boolean
  id?: string
  ok?: boolean
  error?: string
}

/** Parse one NDJSON line from the resident worker's stdout. A blank line (after
 *  trim) or malformed JSON yields null — the caller skips it. */
export function parseServeLine(line: string): ServeMsg | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as ServeMsg
  } catch {
    return null
  }
}

const TTS_PROGRESS_PREFIX = 'OFFGRID_TTS_PROGRESS '

/** Parse one progress diagnostic from the worker's stderr. Other worker logs
 * remain ordinary diagnostics and malformed progress lines are ignored. */
export function parseTtsProgressLine(line: string): number | null {
  if (!line.startsWith(TTS_PROGRESS_PREFIX)) return null
  try {
    const event = JSON.parse(line.slice(TTS_PROGRESS_PREFIX.length)) as { progress?: unknown }
    if (typeof event.progress !== 'number' || !Number.isFinite(event.progress)) return null
    return Math.max(0, Math.min(100, event.progress))
  } catch {
    return null
  }
}

/** Parse and validate the runtime-owned voice catalogue returned by the worker. */
export function parseRuntimeVoiceCatalog(output: string): RuntimeSpeechVoice[] {
  try {
    const parsed = JSON.parse(output) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (voice): voice is RuntimeSpeechVoice =>
        typeof voice === 'object' &&
        voice !== null &&
        typeof voice.id === 'string' &&
        (voice.label === undefined || typeof voice.label === 'string') &&
        (voice.language === undefined || typeof voice.language === 'string')
    )
  } catch {
    return []
  }
}
import type { RuntimeSpeechVoice } from '@offgrid/speech'
