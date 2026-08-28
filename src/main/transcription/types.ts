// The transcription seam. Everything that turns audio into text depends on this
// interface, never on whisper-cli directly. WhisperCliTranscription is the only
// implementation today; a Parakeet (sherpa-onnx) or Apple Speech backend can be
// added later as a new class with zero changes to callers (dictation, meetings,
// file ingest). Model selection, the ffmpeg 16 kHz-mono re-encode, and the
// hallucination-suppression flags live behind here as the single source of truth.

export interface Seg {
  start: number
  end: number
  text: string
}

export interface Transcript {
  text: string
  segments?: Seg[]
  language?: string
}

export interface TranscribeOptions {
  /** Cancel this one transcription. Native adapters must pass it to their process/request boundary. */
  signal?: AbortSignal
  /** Model file: absolute path, or a filename resolved in the models dir.
   *  Defaults to the user's configured/auto-picked transcription model. */
  model?: string
  /** Spoken-language hint; 'auto' detects. Default 'auto'. */
  language?: string
  /** Suppress non-speech tokens + the repetition loop (whisper -sns -mc 0). Default true. */
  suppressNonSpeech?: boolean
  /** Input is already 16 kHz mono PCM WAV — skip the ffmpeg re-encode. Default false. */
  alreadyWav16k?: boolean
  /** Initial-prompt text that biases recognition toward custom vocabulary
   *  (names, jargon) — whisper's --prompt. Keep it short. */
  prompt?: string
  /** Return per-utterance timestamped `segments` (drops whisper's -nt). Callers
   *  that need to interleave/diarize by time (meetings) set this; plain dictation
   *  leaves it off and reads only `text`. Default false. */
  timestamps?: boolean
}

export interface TranscriptionService {
  /** True when a runtime + a model are installed and transcription can run now. */
  isAvailable(): boolean
  /** Transcribe an audio (or A/V) file at `input.path` to text. */
  transcribe(input: { path: string }, opts?: TranscribeOptions): Promise<Transcript>
}
