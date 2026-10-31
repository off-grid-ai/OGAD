// Long recordings reach Parakeet and Qwen3-ASR in pieces. Both take a whole clip at once (sherpa-onnx
// encodes the full wave; Qwen3-ASR turns it into audio tokens in one llama.cpp context), so an hour-
// long meeting in one pass would exhaust memory. Whisper's 30-second window is the published unit
// these models are trained and evaluated on (Open ASR Leaderboard, Qwen3-ASR model card), so a clip
// is cut into pieces of at most 30 seconds, each cut at the quietest moment of its last 10 seconds
// so a word is not split in two.

import fs from 'fs'
import path from 'path'
import { decodeWavPcm16, encodeWav } from './wav'
import { rms } from './vad'
import type { Seg } from './types'

export const CHUNK_SAMPLE_RATE = 16_000
const MAX_CHUNK_SECONDS = 30
const MIN_CHUNK_SECONDS = 20

/** Sample ranges [start, end) that cover the whole clip, each at most 30 s. Pure. */
export function chunkRanges(
  sampleCount: number,
  quietness: (start: number, end: number) => number,
  sampleRate = CHUNK_SAMPLE_RATE
): Array<{ start: number; end: number }> {
  const max = MAX_CHUNK_SECONDS * sampleRate
  const min = MIN_CHUNK_SECONDS * sampleRate
  // 100 ms frames when looking for the quietest place to cut.
  const frame = sampleRate / 10
  const ranges: Array<{ start: number; end: number }> = []
  let start = 0
  while (sampleCount - start > max) {
    let cut = start + max
    let quietest = Infinity
    for (let at = start + min; at + frame <= start + max; at += frame) {
      const level = quietness(at, at + frame)
      if (level < quietest) {
        quietest = level
        cut = at + Math.floor(frame / 2)
      }
    }
    ranges.push({ start, end: cut })
    start = cut
  }
  if (sampleCount > start || ranges.length === 0) ranges.push({ start, end: sampleCount })
  return ranges
}

export interface WavChunk {
  path: string
  /** Seconds from the start of the recording. */
  start: number
  end: number
}

/**
 * Cut a 16 kHz mono 16-bit WAV into pieces of at most 30 s in `dir`. A clip that already fits is
 * returned as itself (no copy). The caller owns `dir` and removes it.
 */
export async function splitWav(wavPath: string, dir: string): Promise<WavChunk[]> {
  const samples = decodeWavPcm16(new Uint8Array(await fs.promises.readFile(wavPath)))
  const ranges = chunkRanges(samples.length, (start, end) => rms(samples.subarray(start, end)))
  const seconds = (at: number): number => at / CHUNK_SAMPLE_RATE
  if (ranges.length === 1) return [{ path: wavPath, start: 0, end: seconds(samples.length) }]
  await fs.promises.mkdir(dir, { recursive: true })
  const chunks: WavChunk[] = []
  for (const [index, range] of ranges.entries()) {
    const file = path.join(dir, `chunk-${String(index).padStart(4, '0')}.wav`)
    await fs.promises.writeFile(
      file,
      encodeWav(samples.subarray(range.start, range.end), CHUNK_SAMPLE_RATE)
    )
    chunks.push({ path: file, start: seconds(range.start), end: seconds(range.end) })
  }
  return chunks
}

/** One transcript from the pieces' texts: the joined text and a timed segment per spoken piece. */
export function joinChunkTexts(
  chunks: readonly WavChunk[],
  texts: readonly string[]
): { text: string; segments: Seg[] } {
  const segments = chunks
    .map((chunk, index) => ({
      start: chunk.start,
      end: chunk.end,
      text: (texts[index] ?? '').trim()
    }))
    .filter((segment) => segment.text)
  return { text: segments.map((segment) => segment.text).join(' '), segments }
}
