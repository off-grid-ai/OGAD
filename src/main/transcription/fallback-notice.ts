// When Parakeet or Qwen3-ASR fails on a recording and Whisper transcribes it instead, the person is
// told. The transcription seam reports here; the app shows it (tts-ipc.ts sends it to every window).

export interface TranscriptionFallbackNotice {
  engine: 'parakeet' | 'qwen3-asr'
  reason: string
}

let listener: ((notice: TranscriptionFallbackNotice) => void) | null = null

/** The app's one listener (a later call replaces it). */
export function onTranscriptionFallback(
  next: ((notice: TranscriptionFallbackNotice) => void) | null
): void {
  listener = next
}

export function reportTranscriptionFallback(notice: TranscriptionFallbackNotice): void {
  try {
    listener?.(notice)
  } catch (error) {
    console.error('[transcription] fallback notice failed', error)
  }
}
