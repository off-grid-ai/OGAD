import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeWav } from '../wav'
import { wavHasSpeech, MIN_SPEECH_SECONDS } from '../silence-gate'

const RATE = 16_000

/** `seconds` of silence with a loud tone from `toneAt` for `toneSeconds`. */
function recording(seconds: number, toneAt = 0, toneSeconds = 0, amp = 0.3): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE))
  const from = Math.round(toneAt * RATE)
  const to = Math.min(out.length, from + Math.round(toneSeconds * RATE))
  for (let i = from; i < to; i++) out[i] = Math.sin(i / 4) * amp
  return out
}

describe('wavHasSpeech', () => {
  let dir = ''
  const write = (name: string, bytes: Uint8Array): string => {
    const file = path.join(dir, name)
    fs.writeFileSync(file, bytes)
    return file
  }
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-silence-gate-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('finds no speech in a silent recording', async () => {
    expect(await wavHasSpeech(write('silent.wav', encodeWav(recording(28), RATE)))).toBe(false)
  })

  it('finds no speech in room tone below the gate', async () => {
    expect(await wavHasSpeech(write('hum.wav', encodeWav(recording(5, 0, 5, 0.002), RATE)))).toBe(
      false
    )
  })

  it('finds speech in a single short word late in a long silent recording', async () => {
    const wav = encodeWav(recording(120, 118, MIN_SPEECH_SECONDS + 0.1), RATE)
    expect(await wavHasSpeech(write('one-word.wav', wav))).toBe(true)
  })

  it('does not count a click shorter than a word as speech', async () => {
    expect(await wavHasSpeech(write('click.wav', encodeWav(recording(10, 4, 0.1), RATE)))).toBe(
      false
    )
  })

  it('reads only the data chunk, not a loud chunk written after it', async () => {
    const silent = encodeWav(recording(2), RATE)
    const trailer = new Uint8Array(8 + 32_000)
    trailer.set([0x4c, 0x49, 0x53, 0x54]) // "LIST"
    new DataView(trailer.buffer).setUint32(4, 32_000, true)
    for (let i = 8; i < trailer.length; i += 2) trailer[i + 1] = i % 4 ? 0x60 : 0xa0
    const bytes = new Uint8Array(silent.length + trailer.length)
    bytes.set(silent)
    bytes.set(trailer, silent.length)
    expect(await wavHasSpeech(write('trailer.wav', bytes))).toBe(false)
  })

  it('treats a file it cannot read as WAV as speech, so nothing is skipped unmeasured', async () => {
    expect(await wavHasSpeech(write('not.wav', new TextEncoder().encode('synthetic wav')))).toBe(
      true
    )
  })

  it('treats an empty data chunk as silence', async () => {
    expect(await wavHasSpeech(write('empty.wav', encodeWav(new Float32Array(0), RATE)))).toBe(false)
  })
})
