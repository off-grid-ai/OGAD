// Whisper does not return nothing for silence: given a recording with no voice in it, it
// writes a word ("You", "Thanks for watching") and a meeting then shows that word as
// something you said. The gate is here, on the decoded 16 kHz WAV every Whisper pass reads,
// so no caller (meetings, file ingest, dictation) can send silence to Whisper.
import fs from 'fs'
import { findDataChunk } from './wav'
import { isSpeech, DEFAULT_SPEECH_RMS } from './vad'

/** Voice shorter than this in a whole recording is not speech. 0.3 s is less than one short
 *  word, so a recording with a single "yes" in it still goes to Whisper. */
export const MIN_SPEECH_SECONDS = 0.3

const SAMPLE_RATE = 16_000
const FRAME_SAMPLES = 1600 // 100 ms, the same frame the dictation gate uses
const HEADER_BYTES = 4096
const READ_BYTES = FRAME_SAMPLES * 2 * 64 // 6.4 s of 16-bit PCM per read

/**
 * True when a 16 kHz mono 16-bit WAV has at least `minSeconds` of frames loud enough to be
 * speech. It reads the file in blocks and stops at the first `minSeconds` of voice, so a real
 * meeting costs a few kilobytes, not the whole file. A file it cannot read as WAV counts as
 * speech: the gate only ever skips audio it has measured as silent.
 */
export async function wavHasSpeech(
  wavPath: string,
  minSeconds: number = MIN_SPEECH_SECONDS,
  threshold: number = DEFAULT_SPEECH_RMS
): Promise<boolean> {
  const handle = await fs.promises.open(wavPath, 'r')
  try {
    const head = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await handle.read(head, 0, HEADER_BYTES, 0)
    const data = findDataChunk(new DataView(head.buffer, head.byteOffset, bytesRead), bytesRead)
    if (!data) return true
    const needed = Math.max(1, Math.ceil((minSeconds * SAMPLE_RATE) / FRAME_SAMPLES))
    const block = Buffer.alloc(READ_BYTES)
    const frame = new Float32Array(FRAME_SAMPLES)
    let found = 0
    // The data chunk's declared length bounds the read, so a chunk after it is never read as sound.
    const end = data.offset + head.readUInt32LE(data.offset - 4)
    let position = data.offset
    for (;;) {
      const { bytesRead: read } = await handle.read(block, 0, READ_BYTES, position)
      const n = Math.min(read, end - position)
      if (n < 2) return false
      position += n
      const samples = n >> 1
      for (let start = 0; start < samples; start += FRAME_SAMPLES) {
        const count = Math.min(FRAME_SAMPLES, samples - start)
        for (let i = 0; i < count; i++) {
          const s = block.readInt16LE((start + i) * 2)
          frame[i] = s < 0 ? s / 0x8000 : s / 0x7fff
        }
        if (isSpeech(frame.subarray(0, count), threshold) && ++found >= needed) return true
      }
    }
  } finally {
    await handle.close()
  }
}
