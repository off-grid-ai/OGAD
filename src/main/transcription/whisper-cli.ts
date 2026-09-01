// WhisperCliTranscription — the only TranscriptionService implementation today.
// Wraps the bundled whisper-cli + ffmpeg. The binary/model resolvers live here
// (extractors.ts re-exports them for back-compat) so model selection and the
// ffmpeg 16 kHz-mono re-encode are defined once and reused by dictation interim
// ticks, final passes, file ingest, and meeting transcription alike.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { getActiveModal } from '../active-models'
import { binRoots, modelsDir, exe } from '../runtime-env'
import {
  parseWhisperSegments,
  resolveActiveWhisperFilename,
  resolveTranscriptionDecode,
  selectWhisperModelFilename,
  strongerMultilingualWhisperFilename,
  transcriptLanguage,
  transcribeWithQualityRecovery,
  modelsByKind
} from '@offgrid/models'
import { existing } from './bin-resolution'
import { decodeToWavArgs, DECODE_TIMEOUT_MS } from './ffmpeg-decode'
import type { TranscriptionService, Transcript, TranscribeOptions } from './types'
import { runNativeTranscriptionProcess } from './native-process'

const HINDI_DEVANAGARI_PROMPT = 'यह ऑडियो हिंदी में है। हिंदी को केवल देवनागरी लिपि में लिखें।'

/** Resolve the bundled whisper-cli across dev / packaged layouts. System Health
 * reuses this exact runtime resolver so its Installed claim cannot drift from
 * the executable the transcription service will actually launch. */
export function whisperBin(): string | null {
  return existing(binRoots().map((r) => path.join(r, 'whisper', exe('whisper-cli'))))
}

/** Resolve ffmpeg: bundled first, then common system locations. */
export function ffmpegBin(): string | null {
  return existing([
    ...binRoots().map((r) => path.join(r, exe('ffmpeg'))),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg'
  ])
}

/** List downloaded whisper ggml models (filenames) in the user's models dir. */
function whisperModelFiles(): string[] {
  try {
    return fs.readdirSync(modelsDir()).filter((f) => /^ggml-.*\.bin$/i.test(f))
  } catch {
    return []
  }
}

/** Resolve the active-transcription pick to a whisper ggml FILENAME, or null when it
 *  isn't a whisper model. The slot may hold a bare ggml filename OR a catalog id (the
 *  Models UI stores the id) - map the id to its primary file. Parakeet ids resolve to
 *  null so their ONNX files are never handed to whisper. */
function activeWhisperFile(chosen: string): string | null {
  return resolveActiveWhisperFilename(chosen, modelsByKind('transcription'))
}

/** Find the model to use for accurate (final) transcription. Prefers a
 *  MULTILINGUAL model (`.en` models are English-only) and a more capable size. */
export function whisperModel(): string | null {
  try {
    const dir = modelsDir()
    // User-chosen transcription model wins, when it's a whisper ggml file present on disk.
    // (The active-transcription slot is shared with Parakeet, whose ONNX files must never
    // be handed to whisper — hence the ggml guard.)
    const chosen = getActiveModal('transcription')
    const chosenFile = chosen ? activeWhisperFile(chosen) : null
    if (chosenFile && fs.existsSync(path.join(dir, chosenFile))) return path.join(dir, chosenFile)
    const files = whisperModelFiles()
    if (!files.length) return null
    const pick = selectWhisperModelFilename(files, 'quality')!
    return path.join(dir, pick)
  } catch {
    return null // transient fs/store error → "no model", not a thrown exception
  }
}

/** Smallest available model — used for fast, display-only dictation interim
 *  ticks where latency matters more than accuracy. Respects the user's explicit
 *  transcription model choice (getActiveModal); otherwise picks the smallest. */
export function smallWhisperModel(): string | null {
  const dir = modelsDir()
  try {
    const chosen = getActiveModal('transcription')
    const chosenFile = chosen ? activeWhisperFile(chosen) : null
    if (chosenFile && fs.existsSync(path.join(dir, chosenFile))) return path.join(dir, chosenFile)
  } catch {
    /* fall through to size-based pick */
  }
  const files = whisperModelFiles()
  if (!files.length) return null
  const pick = selectWhisperModelFilename(files, 'speed')!
  return path.join(dir, pick)
}

/** Resolve an opts.model (abs path or filename in modelsDir) to an absolute path. */
function resolveModel(model?: string): string | null {
  if (!model) return whisperModel()
  if (path.isAbsolute(model) && fs.existsSync(model)) return model
  const inDir = path.join(modelsDir(), model)
  if (fs.existsSync(inDir)) return inDir
  return whisperModel()
}

class WhisperCliTranscription implements TranscriptionService {
  isAvailable(): boolean {
    // ffmpeg is only required when the caller passes non-WAV input; transcription of
    // pre-converted 16 kHz WAV (alreadyWav16k:true) succeeds without it. Report
    // available if whisper + a model are present — the transcribe() call validates
    // ffmpeg at that point when it's actually needed.
    return !!whisperBin() && !!whisperModel()
  }

  async transcribe(input: { path: string }, opts: TranscribeOptions = {}): Promise<Transcript> {
    const bin = whisperBin()
    if (!bin) throw new Error('Transcription runtime (whisper) is not installed.')
    const model = resolveModel(opts.model)
    if (!model)
      throw new Error('No transcription model found — download Whisper from Models first.')

    const decode = resolveTranscriptionDecode(opts)

    let wav = input.path
    let tmp: string | null = null
    if (!decode.alreadyWav16k) {
      const ff = ffmpegBin()
      if (!ff) throw new Error('ffmpeg is required to decode audio and was not found.')
      tmp = path.join(os.tmpdir(), `offgrid-stt-${Date.now()}-${process.pid}.wav`)
      // 16 kHz mono PCM WAV; -vn drops any video track so A/V files work too.
      // Cap the decode so a malformed/streaming input can't hang the process forever.
      try {
        await runNativeTranscriptionProcess(ff, decodeToWavArgs(input.path, tmp), {
          timeout: DECODE_TIMEOUT_MS,
          signal: opts.signal
        })
      } catch (e) {
        fs.promises.unlink(tmp).catch(() => {})
        throw e
      }
      wav = tmp
    }

    try {
      // -nt strips timestamps (plain text). Keep them when the caller wants
      // per-utterance segments (meetings interleave two speakers by time).
      const args = ['-m', model, '-f', wav, '-l', decode.language, '-np']
      if (!decode.timestamps) args.push('-nt')
      // -mc 0 + -sns: kill the repetition/hallucination loop + non-speech tokens.
      if (decode.suppressNonSpeech) args.push('-mc', '0', '-sns')
      // Bias toward custom vocabulary (names/jargon) via the initial prompt.
      const prompt =
        decode.language === 'hi'
          ? [HINDI_DEVANAGARI_PROMPT, decode.prompt].filter(Boolean).join(' ')
          : decode.prompt
      if (prompt) args.push('--prompt', prompt.slice(0, 800))
      const retryFilename = strongerMultilingualWhisperFilename(
        path.basename(model),
        whisperModelFiles()
      )
      const stdout = await transcribeWithQualityRecovery({
        language: decode.language,
        selectedModel: model,
        retryModel: retryFilename ? path.join(modelsDir(), retryFilename) : null,
        run: async (modelPath) => {
          const runArgs = [...args]
          runArgs[1] = modelPath
          const result = await runNativeTranscriptionProcess(bin, runArgs, {
            maxBuffer: 64 * 1024 * 1024,
            timeout: 30 * 60_000,
            signal: opts.signal
          })
          return result.stdout
        }
      })
      const lang = transcriptLanguage(decode.language)
      if (!decode.timestamps) return { text: stdout.trim(), language: lang }
      const segments = parseWhisperSegments(stdout)
      return {
        text: segments
          .map((s) => s.text)
          .join(' ')
          .trim(),
        segments,
        language: lang
      }
    } finally {
      if (tmp) fs.promises.unlink(tmp).catch(() => {})
    }
  }
}

/** Shared singleton — callers depend on this, not on the class. */
export const transcriptionService: TranscriptionService = new WhisperCliTranscription()
