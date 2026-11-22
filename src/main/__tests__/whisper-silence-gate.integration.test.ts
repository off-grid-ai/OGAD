import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureRuntime } from '../runtime-env'
import { transcriptionService } from '../transcription/whisper-cli'
import { WhisperServerTranscription } from '../transcription/whisper-server-transcription'
import { WhisperServerService } from '../transcription/whisper-server'
import { encodeWav } from '../transcription/wav'

// A meeting with no microphone used to read "You: You" — Whisper writes a word for silence.
// These drive the real services against a stand-in whisper binary that logs each call and
// always "hears" You, as the real one does on silence.
const RATE = 16_000
const silence = (seconds: number): Float32Array => new Float32Array(seconds * RATE)
const voice = (seconds: number): Float32Array => {
  const out = new Float32Array(seconds * RATE)
  for (let i = 0; i < out.length; i++) out[i] = Math.sin(i / 4) * 0.3
  return out
}

describe('Whisper never transcribes silence', () => {
  let root = ''
  let modelsDir = ''
  let logPath = ''
  const wav = (name: string, samples: Float32Array): string => {
    const file = path.join(root, name)
    fs.writeFileSync(file, encodeWav(samples, RATE))
    return file
  }
  const whisperCalls = (): number =>
    fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').length : 0

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-silence-'))
    const binDir = path.join(root, 'bin')
    modelsDir = path.join(root, 'data', 'models')
    logPath = path.join(root, 'whisper-calls.log')
    fs.mkdirSync(path.join(binDir, 'whisper'), { recursive: true })
    fs.mkdirSync(modelsDir, { recursive: true })
    fs.writeFileSync(path.join(modelsDir, 'ggml-base.bin'), 'model')
    const whisper = path.join(binDir, 'whisper', 'whisper-cli')
    fs.writeFileSync(
      whisper,
      `#!/usr/bin/env node
require('fs').appendFileSync(process.env.OFFGRID_TEST_WHISPER_LOG, 'call\\n')
process.stdout.write('[00:00:00.000 --> 00:00:01.000]  You\\n')
`
    )
    fs.chmodSync(whisper, 0o755)
    process.env.OFFGRID_TEST_WHISPER_LOG = logPath
    configureRuntime({ dataDir: path.join(root, 'data'), binRoots: [binDir] })
  })

  afterEach(() => {
    configureRuntime({ dataDir: undefined, binRoots: undefined })
    delete process.env.OFFGRID_TEST_WHISPER_LOG
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('returns no words and no segments for a silent track, without running Whisper', async () => {
    const result = await transcriptionService.transcribe(
      { path: wav('mic.wav', silence(28)) },
      { timestamps: true, alreadyWav16k: true, language: 'en' }
    )
    expect(result).toEqual({ text: '', segments: [], language: 'en' })
    expect(whisperCalls()).toBe(0)
  })

  it('returns plain empty text for silence when no timestamps are asked for', async () => {
    const result = await transcriptionService.transcribe(
      { path: wav('mic.wav', silence(3)) },
      { alreadyWav16k: true }
    )
    expect(result).toEqual({ text: '', language: undefined })
    expect(whisperCalls()).toBe(0)
  })

  it('still runs Whisper on a track with a voice in it', async () => {
    const result = await transcriptionService.transcribe(
      { path: wav('mic.wav', voice(2)) },
      { timestamps: true, alreadyWav16k: true }
    )
    expect(result.segments).toEqual([{ start: 0, end: 1, text: 'You' }])
    expect(whisperCalls()).toBe(1)
  })

  it('runs Whisper on silence when the caller turns non-speech suppression off', async () => {
    await transcriptionService.transcribe(
      { path: wav('mic.wav', silence(3)) },
      { alreadyWav16k: true, suppressNonSpeech: false }
    )
    expect(whisperCalls()).toBe(1)
  })

  it('the resident Whisper returns empty text for silence without starting the server', async () => {
    const model = path.join(modelsDir, 'ggml-base.bin')
    // No whisper-server is installed: reaching the server would throw.
    const runtime = new WhisperServerService(0)
    const resident = new WhisperServerTranscription(runtime)
    await expect(
      resident.transcribe({ path: wav('mic.wav', silence(5)) }, { model, alreadyWav16k: true })
    ).resolves.toEqual({ text: '', language: undefined })
    await expect(
      resident.transcribe(
        { path: wav('mic.wav', silence(5)) },
        { model, alreadyWav16k: true, language: 'fr' }
      )
    ).resolves.toEqual({ text: '', language: 'fr' })
    await expect(
      resident.transcribe({ path: wav('voice.wav', voice(2)) }, { model, alreadyWav16k: true })
    ).rejects.toThrow()
    runtime.stop()
  })
})
