#!/usr/bin/env node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ExecutorchSpeechRuntime } from '@offgrid/executorch-speech'

const binRoot = path.resolve(process.argv[2] ?? 'dist/linux-unpacked/resources/bin')
const assets = path.resolve(process.argv[3] ?? 'dist/linux-unpacked/resources/speech-assets')
const temporary = await mkdtemp(path.join(os.tmpdir(), 'offgrid-linux-tts-'))
try {
  const outputPath = path.join(temporary, 'probe.wav')
  const runtime = new ExecutorchSpeechRuntime(
    path.join(temporary, 'cache'),
    path.join(binRoot, 'executorch-speech'),
    assets
  )
  await runtime.synthesize({ text: 'Linux voice is ready.', voiceId: 'af_heart', outputPath })
  const wav = await readFile(outputPath)
  if (wav.length <= 44 || wav.toString('ascii', 0, 4) !== 'RIFF' ||
      wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('The Linux speech runtime did not produce a valid WAV file.')
  }
  console.log(`[probe-linux-tts] generated ${wav.length} WAV bytes`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
