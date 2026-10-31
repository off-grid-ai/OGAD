// The real engines on a real recording: the bundled sherpa-onnx (Parakeet TDT 0.6B v2) and the
// bundled llama-server (Qwen3-ASR) transcribe whisper.cpp's jfk.wav through the app's own
// transcription seam. Runs only where the models are on disk: point OFFGRID_SPEECH_MODELS_DIR at
// a folder holding the catalog files and jfk.wav, with resources/bin staged
// (node scripts/fetch-sherpa.mjs).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { binRoots, configureRuntime, dataDir, modelsDir } from '../../runtime-env'
import { getLocalTranscription } from '../select'
import { qwen3AsrTranscription } from '../qwen3-asr'

const models = process.env.OFFGRID_SPEECH_MODELS_DIR ?? ''
const clip = path.join(models, 'jfk.wav')
const ready = !!models && fs.existsSync(clip)
const SAID =
  'and so my fellow americans ask not what your country can do for you ask what you can do for your country'

const words = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

describe.skipIf(!ready)('Parakeet and Qwen3-ASR on a real recording', () => {
  const previous = { dataDir: dataDir(), binRoots: binRoots(), modelsDir: modelsDir() }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-speech-real-'))
  configureRuntime({
    dataDir: profile,
    binRoots: [path.resolve(__dirname, '../../../../resources/bin')],
    modelsDir: models
  })
  const choose = (id: string): void =>
    fs.writeFileSync(
      path.join(models, 'active-modalities.json'),
      JSON.stringify({ transcription: id })
    )

  afterAll(async () => {
    qwen3AsrTranscription.stop()
    configureRuntime(previous)
    fs.rmSync(path.join(models, 'active-modalities.json'), { force: true })
    fs.rmSync(profile, { recursive: true, force: true })
  })

  it.each([
    ['Parakeet TDT 0.6B v2', 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8', 'auto'],
    ['Qwen3-ASR 1.7B', 'ggml-org/Qwen3-ASR-1.7B-GGUF', 'auto'],
    ['Qwen3-ASR 1.7B, English pinned', 'ggml-org/Qwen3-ASR-1.7B-GGUF', 'en']
  ])(
    '%s hears the JFK clip word for word',
    async (name, id, language) => {
      choose(id)
      const started = Date.now()
      const { text } = await getLocalTranscription(() => language).transcribe(
        { path: clip },
        { alreadyWav16k: true }
      )
      console.warn(`[speech-real] ${name}: ${Date.now() - started} ms: ${text}`)
      expect(words(text)).toBe(SAID)
    },
    300_000
  )
})
