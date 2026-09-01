// ParakeetCliTranscription — a second TranscriptionService engine alongside whisper,
// for higher-accuracy on-device speech-to-text (NVIDIA Parakeet). It is ADDITIVE:
// whisper stays the default; dictation lets the user opt into Parakeet, and everything
// degrades to whisper when the Parakeet binary/model isn't bundled yet.
//
// Runtime: a self-contained sherpa-onnx offline-transducer CLI + a Parakeet ONNX model
// (encoder/decoder/joiner + tokens), staged into resources by CI — the same "bundled
// engine binary" shape as whisper-cli. No Python. ffmpeg (already bundled) decodes to
// 16 kHz mono WAV first, exactly like the whisper path.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { binRoots, modelsDir } from '../runtime-env'
import { getActiveModal } from '../active-models'
import { modelsByKind, transcriptionModelsByEngine } from '@offgrid/models'
import { ffmpegBin } from './whisper-cli'
import { existing } from './bin-resolution'
import { decodeToWavArgs, DECODE_TIMEOUT_MS } from './ffmpeg-decode'
import type { TranscriptionService, Transcript, TranscribeOptions } from './types'
import { runNativeTranscriptionProcess } from './native-process'

/** Resolve the bundled sherpa-onnx offline CLI across dev / packaged layouts. The CI
 *  stager preserves the prebuilt's bin/ + lib/ structure (so its @rpath finds the
 *  dylibs), hence bin/sherpa-onnx-offline; the flat path is a fallback. */
function parakeetBin(): string | null {
  return existing([
    ...binRoots().map((r) => path.join(r, 'parakeet', 'bin', 'sherpa-onnx-offline')),
    ...binRoots().map((r) => path.join(r, 'parakeet', 'sherpa-onnx-offline'))
  ])
}

/** The four files a sherpa-onnx offline transducer needs (bundled-default names). */
const MODEL_FILES = ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'] as const

export interface ParakeetModel {
  dir: string
  encoder: string
  decoder: string
  joiner: string
  tokens: string
}

/**
 * Pick the encoder/decoder/joiner/tokens files out of a downloaded model's filenames by
 * substring (names are slug-prefixed in the catalog, e.g. "parakeet-v2.encoder.int8.onnx").
 * Pure — returns the four names or null if any role is missing. Testable without disk.
 */
export function matchParakeetFiles(names: string[]): {
  encoder: string
  decoder: string
  joiner: string
  tokens: string
} | null {
  const pick = (needle: string, ext?: RegExp): string | undefined =>
    names.find((n) => n.toLowerCase().includes(needle) && (!ext || ext.test(n)))
  const encoder = pick('encoder', /\.onnx$/i)
  const decoder = pick('decoder', /\.onnx$/i)
  const joiner = pick('joiner', /\.onnx$/i)
  const tokens = pick('tokens', /\.txt$/i)
  if (!encoder || !decoder || !joiner || !tokens) return null
  return { encoder, decoder, joiner, tokens }
}

/** Resolve the Parakeet model to use: the active/downloaded catalog model first, then a
 *  CI-bundled default. Honors the shared active-transcription slot when it names a
 *  Parakeet file; otherwise uses the first fully-downloaded Parakeet catalog entry. */
function parakeetModel(): ParakeetModel | null {
  const fromCatalog = downloadedCatalogModel()
  if (fromCatalog) return fromCatalog
  // Bundled default (CI-staged) — fixed file names in resources/bin/parakeet/model.
  for (const dir of binRoots().map((r) => path.join(r, 'parakeet', 'model'))) {
    if (MODEL_FILES.every((f) => existsIn(dir, f))) {
      return {
        dir,
        encoder: path.join(dir, 'encoder.onnx'),
        decoder: path.join(dir, 'decoder.onnx'),
        joiner: path.join(dir, 'joiner.onnx'),
        tokens: path.join(dir, 'tokens.txt')
      }
    }
  }
  return null
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
function downloadedCatalogModel(): ParakeetModel | null {
  const dir = modelsDir()
  // Partition the catalog by engine in ONE place (select.modelsByEngine), not a local
  // `m.engine === 'parakeet'` filter duplicated against whisper-cli's classification.
  const entries = transcriptionModelsByEngine('parakeet', modelsByKind('transcription'))
  if (!entries.length) return null
  const active = getActiveModal('transcription')
  const ordered = active
    ? [...entries].sort((a, b) =>
        activeMatchesEntry(active, a) ? -1 : activeMatchesEntry(active, b) ? 1 : 0
      )
    : entries
  for (const e of ordered) {
    const names = e.files.map((f) => f.name)
    const matched = matchParakeetFiles(names)
    if (!matched) continue
    if (
      ![matched.encoder, matched.decoder, matched.joiner, matched.tokens].every((n) =>
        existsIn(dir, n)
      )
    )
      continue
    return {
      dir,
      encoder: path.join(dir, matched.encoder),
      decoder: path.join(dir, matched.decoder),
      joiner: path.join(dir, matched.joiner),
      tokens: path.join(dir, matched.tokens)
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
 * Build the sherpa-onnx offline-transducer argv for one WAV file. Pure, so the exact
 * flag shape is asserted in tests and easy to adjust when the CI binary is finalized.
 */
export function buildParakeetArgs(model: ParakeetModel, wav: string, threads = 4): string[] {
  // sherpa-onnx-offline infers "transducer" from the encoder/decoder/joiner trio - there
  // is no --model-type flag. The wav is positional (last). Verified against v1.13.3 --help.
  return [
    `--tokens=${model.tokens}`,
    `--encoder=${model.encoder}`,
    `--decoder=${model.decoder}`,
    `--joiner=${model.joiner}`,
    `--num-threads=${threads}`,
    '--decoding-method=greedy_search',
    wav
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

function unescapeJson(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\\\\/g, '\\')
}

class ParakeetCliTranscription implements TranscriptionService {
  isAvailable(): boolean {
    return !!parakeetBin() && !!parakeetModel()
  }

  async transcribe(input: { path: string }, opts: TranscribeOptions = {}): Promise<Transcript> {
    const bin = parakeetBin()
    if (!bin) throw new Error('Parakeet runtime is not installed.')
    const model = parakeetModel()
    if (!model) throw new Error('No Parakeet model found.')

    let wav = input.path
    let tmp: string | null = null
    if (!opts.alreadyWav16k) {
      const ff = ffmpegBin()
      if (!ff) throw new Error('ffmpeg is required to decode audio and was not found.')
      tmp = path.join(os.tmpdir(), `offgrid-parakeet-${Date.now()}-${process.pid}.wav`)
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
      const { stdout } = await runNativeTranscriptionProcess(bin, buildParakeetArgs(model, wav), {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30 * 60_000,
        signal: opts.signal
      })
      const text = parseParakeetOutput(stdout)
      // Parakeet models here are English transducers; report language when the caller pinned one.
      const language = opts.language && opts.language !== 'auto' ? opts.language : undefined
      return { text, language }
    } finally {
      if (tmp) fs.promises.unlink(tmp).catch(() => {})
    }
  }
}

/** Shared singleton — callers depend on the interface, not the class. */
export const parakeetTranscription: TranscriptionService = new ParakeetCliTranscription()
