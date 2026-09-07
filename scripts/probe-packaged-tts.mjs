#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const app = process.argv[2]
if (!app || !fs.statSync(app, { throwIfNoEntry: false })?.isDirectory()) {
  process.stderr.write('usage: node scripts/probe-packaged-tts.mjs <path-to.app>\n')
  process.exit(2)
}

const executable = path.join(app, 'Contents', 'Resources', 'bin', 'executorch-speech')
const probe = spawnSync(executable, ['--probe'], { encoding: 'utf8', timeout: 30_000 })
let payload
try {
  payload = JSON.parse(probe.stdout.trim())
} catch {
  payload = null
}
if (probe.status !== 0 || payload?.runtime !== 'executorch' || payload?.kokoro !== true) {
  process.stderr.write(
    [
      '[tts-probe] packaged ExecuTorch runtime failed',
      `status=${String(probe.status)} signal=${String(probe.signal)}`,
      `stdout=${probe.stdout.trim()}`,
      `stderr=${probe.stderr.trim()}`
    ].join('\n') + '\n'
  )
  process.exit(1)
}
process.stdout.write('[tts-probe] packaged ExecuTorch Kokoro runtime resolved\n')

if (process.argv.includes('--synthesize')) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-packaged-tts-'))
  const wavPath = path.join(temp, 'proof.wav')
  try {
    const { ExecutorchSpeechRuntime } = await import('@offgrid/executorch-speech')
    const bundledAssets = path.join(app, 'Contents', 'Resources', 'speech-assets')
    const runtime = new ExecutorchSpeechRuntime(
      path.join(temp, 'cache'),
      executable,
      bundledAssets
    )
    await runtime.synthesize({
      text: 'Off Grid AI speech is ready.',
      voiceId: 'af_heart',
      outputPath: wavPath
    })
    const wav = fs.readFileSync(wavPath)
    let energy = 0
    for (let offset = 44; offset + 1 < wav.length; offset += 2) {
      energy += Math.abs(wav.readInt16LE(offset))
    }
    const valid =
      wav.toString('ascii', 0, 4) === 'RIFF' &&
      wav.toString('ascii', 8, 12) === 'WAVE' &&
      wav.readUInt16LE(20) === 1 &&
      wav.readUInt16LE(22) === 1 &&
      wav.readUInt32LE(24) === 24_000 &&
      wav.readUInt16LE(34) === 16 &&
      wav.length > 44 &&
      energy > 0
    if (!valid) throw new Error(`invalid synthesis: bytes=${wav.length} energy=${energy}`)
    process.stdout.write(
      `[tts-probe] synthesized ${wav.length} bytes of non-zero PCM16 mono 24kHz audio\n`
    )
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
