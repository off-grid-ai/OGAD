// ParakeetCliTranscription — speech-to-text on the sherpa-onnx offline CLI (NVIDIA Parakeet).
// Opt-in beside whisper: the person picks a Parakeet model on the Models screen or in dictation.
//
// Runtime: the sherpa-onnx CLI pinned in resources/engine-pins.json (`sherpa`) and staged into
// resources/bin/parakeet by scripts/fetch-sherpa.mjs on macOS, Windows and Linux. No Python.
// ffmpeg (already bundled) decodes to 16 kHz mono WAV first, exactly like the whisper path, and a
// long recording goes through in 30-second pieces (chunk.ts).

import { randomUUID } from 'crypto'
import fs from 'fs'
import { recordAIRequest } from '../ai-request-log'
import os from 'os'
import path from 'path'
import { modelReadDirectories } from '../model-paths'
import { getActiveModal } from '../active-models'
import { ffmpegBin } from './whisper-cli'
import { parakeetBinary } from '../runtime-availability'
import { modelsByEngine } from './classify'
import { decodeToWavArgs, DECODE_TIMEOUT_MS } from './ffmpeg-decode'
import { joinChunkTexts, splitWav } from './chunk'
import type { TranscriptionService, Transcript, TranscribeOptions } from './types'
import { runNativeTranscriptionProcess } from './native-process'

/**
 * The sherpa-onnx model families this app runs, with the files each needs and the flags it loads
 * by. Every Parakeet in the catalog is a NeMo TDT transducer. Canary, Moonshine and Cohere
 * Transcribe load through other flags (`--canary-encoder`, `--moonshine-encoder`,
 * `--cohere-transcribe-encoder`, sherpa-onnx v2.0.1); each becomes an entry here when a catalog
 * model of that family is verified.
 */
export type SherpaFamily = 'nemo-transducer'

interface SherpaFamilySpec {
  /** Role -> how its file is found among a catalog entry's file names. */
  files: Record<string, { needle: string; ext: RegExp }>
  /** The model flags for this family, from the resolved file paths by role. */
  args(files: Record<string, string>): string[]
}

const SHERPA_FAMILIES: Record<SherpaFamily, SherpaFamilySpec> = {
  'nemo-transducer': {
    files: {
      encoder: { needle: 'encoder', ext: /\.onnx$/i },
      decoder: { needle: 'decoder', ext: /\.onnx$/i },
      joiner: { needle: 'joiner', ext: /\.onnx$/i },
      tokens: { needle: 'tokens', ext: /\.txt$/i }
    },
    // Naming the type skips sherpa-onnx's second model load to detect it (its --model-type help).
    args: (f) => [
      `--tokens=${f.tokens}`,
      `--encoder=${f.encoder}`,
      `--decoder=${f.decoder}`,
      `--joiner=${f.joiner}`,
      '--model-type=nemo_transducer'
    ]
  }
}

/** The family a catalog entry belongs to. Every catalog Parakeet is a NeMo TDT transducer. */
function sherpaFamily(_entry: { id: string }): SherpaFamily {
  return 'nemo-transducer'
}

export interface ParakeetModel {
  family: SherpaFamily
  /** Absolute file path by role (see SHERPA_FAMILIES). */
  files: Record<string, string>
}

/**
 * Pick each role's file out of a downloaded model's filenames by substring (names are
 * slug-prefixed in the catalog, e.g. "parakeet-v2.encoder.int8.onnx"). Pure — returns the
 * file name per role, or null if any role is missing. Testable without disk.
 */
export function matchSherpaFiles(
  family: SherpaFamily,
  names: readonly string[]
): Record<string, string> | null {
  const matched: Record<string, string> = {}
  for (const [role, { needle, ext }] of Object.entries(SHERPA_FAMILIES[family].files)) {
    const name = names.find((n) => n.toLowerCase().includes(needle) && ext.test(n))
    if (!name) return null
    matched[role] = name
  }
  return matched
}

/** Does the active transcription pick refer to this catalog entry? The active-slot stores
 *  EITHER the catalog id or a primary/on-disk filename (see active-models.isModelActive),
 *  so match either form. Pure — exported for testing. */
export function activeMatchesEntry(
  active: string | null,
  entry: { id: string; files: Array<{ name: string }> }
): boolean {
  if (!active) return false
  return entry.id === active || entry.files.some((f) => f.name === active)
}

/** A fully-downloaded Parakeet model from the catalog, in modelsDir. Prefers the entry
 *  the user selected as active (matched by catalog id OR primary filename). */
function parakeetModel(): ParakeetModel | null {
  const entries = modelsByEngine('parakeet')
  if (!entries.length) return null
  const active = getActiveModal('transcription')
  const ordered = active
    ? [...entries].sort((a, b) =>
        activeMatchesEntry(active, a) ? -1 : activeMatchesEntry(active, b) ? 1 : 0
      )
    : entries
  for (const entry of ordered) {
    const family = sherpaFamily(entry)
    const matched = matchSherpaFiles(
      family,
      entry.files.map((f) => f.name)
    )
    if (!matched) continue
    for (const dir of modelReadDirectories()) {
      if (!Object.values(matched).every((name) => existsIn(dir, name))) continue
      return {
        family,
        files: Object.fromEntries(
          Object.entries(matched).map(([role, name]) => [role, path.join(dir, name)])
        )
      }
    }
  }
  return null
}

function existsIn(dir: string, file: string): boolean {
  try {
    return fs.existsSync(path.join(dir, file))
  } catch {
    return false
  }
}

/**
 * The sherpa-onnx offline argv for one or more WAV files: the family's model flags, then the
 * shared decoding flags, then the wavs (positional, last). Pure, so the exact flag shape is
 * asserted in tests.
 */
export function buildParakeetArgs(
  model: ParakeetModel,
  wavs: string | readonly string[],
  threads = 4
): string[] {
  return [
    ...SHERPA_FAMILIES[model.family].args(model.files),
    `--num-threads=${threads}`,
    '--decoding-method=greedy_search',
    ...(typeof wavs === 'string' ? [wavs] : wavs)
  ]
}

/**
 * Extract the transcript from sherpa-onnx offline output. It prints a block per file;
 * the recognized text appears either as JSON ({"text": "..."}) or on a `text:` line.
 * Pure + tolerant so a format tweak in the binary doesn't silently break dictation.
 */
export function parseParakeetOutput(stdout: string): string {
  // Prefer a JSON object with a "text" field (sherpa-onnx --output-format=json style).
  // The capture allows escaped chars (\" \\ \n) inside the string.
  const jsonMatch = stdout.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (jsonMatch) return unescapeJson(jsonMatch[1] as string).trim()
  // Fall back to the last non-empty "text: ..." line.
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*text\s*[:=]\s*(.+)$/i.exec(lines[i] as string)
    if (m) return (m[1] as string).trim()
  }
  return ''
}

/** One transcript per input file, in order: sherpa-onnx prints one JSON result line per wav on
 *  stdout (its file names and timings go to stderr). Pure. */
export function parseParakeetResults(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line.trimStart().startsWith('{'))
    .map((line) => parseParakeetOutput(line))
}

function unescapeJson(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\\\\/g, '\\')
}

/** Pieces decoded per process: sherpa-onnx decodes every file it is given as one batch, so a long
 *  meeting goes through four minutes at a time instead of all at once. */
const PIECES_PER_RUN = 8

class ParakeetCliTranscription implements TranscriptionService {
  isAvailable(): boolean {
    return !!parakeetBinary() && !!parakeetModel()
  }

  async transcribe(input: { path: string }, opts: TranscribeOptions = {}): Promise<Transcript> {
    return recordAIRequest(
      {
        modality: 'stt',
        source: 'Parakeet transcription',
        model: 'Parakeet',
        request: { ...input, ...opts },
        signal: opts.signal
      },
      async (log) => {
        await log.inputFile(input.path)
        const bin = parakeetBinary()
        if (!bin) throw new Error('Parakeet runtime is not installed.')
        const model = parakeetModel()
        if (!model) throw new Error('No Parakeet model found.')

        const work = path.join(os.tmpdir(), `offgrid-parakeet-${process.pid}-${randomUUID()}`)
        try {
          let wav = input.path
          if (!opts.alreadyWav16k) {
            const ff = ffmpegBin()
            if (!ff) throw new Error('ffmpeg is required to decode audio and was not found.')
            await fs.promises.mkdir(work, { recursive: true })
            wav = path.join(work, 'input.wav')
            await runNativeTranscriptionProcess(ff, decodeToWavArgs(input.path, wav), {
              timeout: DECODE_TIMEOUT_MS,
              signal: opts.signal
            })
          }
          const chunks = await splitWav(wav, path.join(work, 'chunks'))
          const texts: string[] = []
          for (let at = 0; at < chunks.length; at += PIECES_PER_RUN) {
            const batch = chunks.slice(at, at + PIECES_PER_RUN)
            const { stdout } = await runNativeTranscriptionProcess(
              bin,
              buildParakeetArgs(
                model,
                batch.map((chunk) => chunk.path)
              ),
              {
                runtimeModel: Object.values(model.files)[0],
                maxBuffer: 64 * 1024 * 1024,
                timeout: 30 * 60_000,
                signal: opts.signal
              }
            )
            const results = parseParakeetResults(stdout)
            if (results.length !== batch.length)
              throw new Error(
                `Parakeet returned ${results.length} results for ${batch.length} pieces of audio.`
              )
            texts.push(...results)
          }
          const { text, segments } = joinChunkTexts(chunks, texts)
          // Parakeet v2 is English; v3 names no language. Report the one the caller pinned.
          const language = opts.language && opts.language !== 'auto' ? opts.language : undefined
          return opts.timestamps ? { text, segments, language } : { text, language }
        } finally {
          await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {})
        }
      }
    )
  }
}

/** Shared singleton — callers depend on the interface, not the class. */
export const parakeetTranscription: TranscriptionService = new ParakeetCliTranscription()
