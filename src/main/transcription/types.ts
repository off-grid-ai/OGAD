// The transcription seam. Everything that turns audio into text depends on this
// interface, never on whisper-cli directly. WhisperCliTranscription is the only
// implementation today; a Parakeet (sherpa-onnx) or Apple Speech backend can be
// added later as a new class with zero changes to callers (dictation, meetings,
// file ingest). Model selection, the ffmpeg 16 kHz-mono re-encode, and the
// hallucination-suppression flags live behind here as the single source of truth.

import type {
  TranscriptResult,
  TranscriptSegment,
  TranscriptionDecodeRequest
} from '@offgrid/models'

export type Seg = TranscriptSegment
export type Transcript = TranscriptResult

export interface TranscribeOptions extends TranscriptionDecodeRequest {
  /** Cancel this one transcription. Native adapters must pass it to their process/request boundary. */
  signal?: AbortSignal
  /** Model file: absolute path, or a filename resolved in the models dir.
   *  Defaults to the user's configured/auto-picked transcription model. */
  model?: string
}

export interface TranscriptionService {
  /** True when a runtime + a model are installed and transcription can run now. */
  isAvailable(): boolean
  /** Transcribe an audio (or A/V) file at `input.path` to text. */
  transcribe(input: { path: string }, opts?: TranscribeOptions): Promise<Transcript>
}
