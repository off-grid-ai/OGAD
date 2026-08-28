// WhisperCliTranscription — the only TranscriptionService implementation today.
// Wraps the bundled whisper-cli + ffmpeg. The binary/model resolvers live here
// (extractors.ts re-exports them for back-compat) so model selection and the
// ffmpeg 16 kHz-mono re-encode are defined once and reused by dictation interim
// ticks, final passes, file ingest, and meeting transcription alike.

import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { getActiveModal } from '../active-models'
import { binRoots, modelsDir, exe } from '../runtime-env'
import { modelsByKind } from '@offgrid/models'
import { existing } from './bin-resolution'
import { catalogEngine } from './classify'
import { decodeToWavArgs, DECODE_TIMEOUT_MS } from './ffmpeg-decode'
import type { TranscriptionService, Transcript, TranscribeOptions, Seg } from './types'

const execFileAsync = promisify(execFile)

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
  if (/ggml-.*\.bin$/i.test(chosen)) return chosen
  const entry = modelsByKind('transcription').find((m) => m.id === chosen)
  // Only whisper entries feed the whisper model path — a Parakeet id (or no match)
  // resolves to null so its ONNX files are never handed to whisper. Classification is
  // the single source of truth in select.catalogEngine, not a local engine check.
  if (!entry || catalogEngine(entry) !== 'whisper') return null
  const primary = (entry.files.find((f) => f.role === 'primary') ?? entry.files[0])?.name
  return primary && /ggml-.*\.bin$/i.test(primary) ? primary : null
}

/** Rank a model filename by capability/size (bigger = more accurate, slower). */
function sizeRank(f: string): number {
  return /large/i.test(f)
    ? 4
    : /medium/i.test(f)
      ? 3
      : /small/i.test(f)
        ? 2
        : /base/i.test(f)
          ? 1
          : 0
}

/** A Hindi transcription should contain Devanagari when it contains Hindi text. A small
 * multilingual Whisper model can occasionally return Latin or Perso-Arabic text even with
 * `-l hi`; that is a model-quality miss, not a request to translate the recording. */
export function hindiTranscriptNeedsQualityRetry(text: string, language: string): boolean {
  if (language !== 'hi' || !text.trim()) return false
  return !/\p{Script=Devanagari}/u.test(text)
}

/** Pick a stronger downloaded multilingual Whisper model for one quality retry. English-only
 * `.en` models cannot correct a Hindi script miss. The active model still runs first; this only
 * returns a model whose catalog-size rank is higher than the one that produced the bad result. */
export function strongerMultilingualWhisperModel(
  currentModel: string,
  files: readonly string[],
  dir: string
): string | null {
  const currentRank = sizeRank(path.basename(currentModel))
  const candidate = files
    .filter((file) => !/\.en\.bin$/i.test(file) && sizeRank(file) > currentRank)
    .sort((a, b) => sizeRank(b) - sizeRank(a))[0]
  return candidate ? path.join(dir, candidate) : null
}

/** Run the selected model first, then make one quality retry when Hindi text has the wrong
 * script and a stronger multilingual model is already on the device. `run` is the native-process
 * boundary, which keeps the decision deterministic and testable without replacing Off Grid code. */
export async function transcribeWithHindiQualityRetry({
  language,
  model,
  modelFiles,
  modelDir,
  run
}: {
  language: string
  model: string
  modelFiles: readonly string[]
  modelDir: string
  run: (modelPath: string) => Promise<string>
}): Promise<string> {
  let stdout = await run(model)
  if (!hindiTranscriptNeedsQualityRetry(stdout, language)) return stdout

  const retryModel = strongerMultilingualWhisperModel(model, modelFiles, modelDir)
  if (retryModel) stdout = await run(retryModel)
  return stdout
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
    const multi = files.filter((f) => !/\.en\.bin$/i.test(f))
    const pool = multi.length ? multi : files
    const pick = [...pool].sort((a, b) => sizeRank(b) - sizeRank(a))[0]! // pool non-empty (files.length checked)
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
  const multi = files.filter((f) => !/\.en\.bin$/i.test(f))
  const pool = multi.length ? multi : files
  const pick = [...pool].sort((a, b) => sizeRank(a) - sizeRank(b))[0]! // smallest first; pool non-empty (files.length checked)
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

    const language = opts.language ?? 'auto'
    const suppress = opts.suppressNonSpeech !== false

    let wav = input.path
    let tmp: string | null = null
    if (!opts.alreadyWav16k) {
      const ff = ffmpegBin()
      if (!ff) throw new Error('ffmpeg is required to decode audio and was not found.')
      tmp = path.join(os.tmpdir(), `offgrid-stt-${Date.now()}-${process.pid}.wav`)
      // 16 kHz mono PCM WAV; -vn drops any video track so A/V files work too.
      // Cap the decode so a malformed/streaming input can't hang the process forever.
      try {
        await execFileAsync(ff, decodeToWavArgs(input.path, tmp), { timeout: DECODE_TIMEOUT_MS })
      } catch (e) {
        fs.promises.unlink(tmp).catch(() => {})
        throw e
      }
      wav = tmp
    }

    try {
      // -nt strips timestamps (plain text). Keep them when the caller wants
      // per-utterance segments (meetings interleave two speakers by time).
      const args = ['-m', model, '-f', wav, '-l', language, '-np']
      if (!opts.timestamps) args.push('-nt')
      // -mc 0 + -sns: kill the repetition/hallucination loop + non-speech tokens.
      if (suppress) args.push('-mc', '0', '-sns')
      // Bias toward custom vocabulary (names/jargon) via the initial prompt.
      const prompt = (opts.prompt ?? '').trim()
      if (prompt) args.push('--prompt', prompt.slice(0, 800))
      const stdout = await transcribeWithHindiQualityRetry({
        language,
        model,
        modelFiles: whisperModelFiles(),
        modelDir: modelsDir(),
        run: async (modelPath) => {
          const runArgs = [...args]
          runArgs[1] = modelPath
          const result = await execFileAsync(bin, runArgs, {
            maxBuffer: 64 * 1024 * 1024,
            timeout: 30 * 60_000
          })
          return result.stdout
        }
      })
      const lang = language === 'auto' ? undefined : language
      if (!opts.timestamps) return { text: stdout.trim(), language: lang }
      const segments = parseSegments(stdout)
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

/** Parse whisper's timestamped output (`[hh:mm:ss.mmm --> hh:mm:ss.mmm]  text`)
 *  into segments. The single source of truth for this format — callers that need
 *  timestamps consume Transcript.segments instead of re-parsing it. */
function parseSegments(stdout: string): Seg[] {
  const re = /\[(\d+):(\d+):(\d+(?:\.\d+)?)\s*-->\s*(\d+):(\d+):(\d+(?:\.\d+)?)\]\s*(.*)/
  const hms = (h: string, m: string, s: string): number => +h * 3600 + +m * 60 + +s
  const out: Seg[] = []
  for (const line of stdout.split('\n')) {
    const m = re.exec(line)
    if (!m) continue
    const text = m[7]!.trim()
    if (!text) continue
    out.push({ start: hms(m[1]!, m[2]!, m[3]!), end: hms(m[4]!, m[5]!, m[6]!), text })
  }
  return out
}

/** Shared singleton — callers depend on this, not on the class. */
export const transcriptionService: TranscriptionService = new WhisperCliTranscription()
