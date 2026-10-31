// An attached recording is kept, so the chat can play it and not only show its transcript.
// Electron's userData location and the native executables (ffmpeg, whisper-cli) are the only
// fakes; the upload's file handling and the transcription service that runs them are real.

import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-audio-upload-'))

vi.mock('electron', () => ({
  app: { getPath: () => userData, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

// The native boundary: ffmpeg decodes (copies the input to its output path) and whisper-cli hears
// nothing, so the transcript is empty and needs no document index either. A Whisper model file sits
// where its download puts it.
const bin = path.join(userData, 'bin')
const previousBin = process.env.OFFGRID_BIN_DIR
process.env.OFFGRID_BIN_DIR = bin
for (const [file, script] of [
  ['ffmpeg', "require('node:fs').copyFileSync(process.argv[4], process.argv.at(-1))"],
  ['whisper/whisper-cli', '']
] as const) {
  fs.mkdirSync(path.dirname(path.join(bin, file)), { recursive: true })
  fs.writeFileSync(path.join(bin, file), `#!/usr/bin/env node\n${script}\n`, { mode: 0o755 })
}
fs.mkdirSync(path.join(userData, 'models'), { recursive: true })
fs.writeFileSync(path.join(userData, 'models', 'ggml-base.bin'), Buffer.alloc(1024, 1))

import { processUpload } from '../files'
import { configureRuntime } from '../runtime-env'

configureRuntime({ dataDir: userData })

afterAll(() => {
  configureRuntime({ dataDir: undefined })
  if (previousBin === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = previousBin
  fs.rmSync(userData, { recursive: true, force: true })
})

describe('processUpload audio', () => {
  it('keeps the recording in uploads and returns its path beside the transcript', async () => {
    const bytes = Buffer.from('RIFF....WAVEfmt fake audio bytes')

    const result = await processUpload('note.wav', bytes)

    expect(result).toMatchObject({ name: 'note.wav', kind: 'audio', text: '' })
    expect(result.path).toBeTruthy()
    expect(path.dirname(result.path!)).toBe(path.join(userData, 'uploads'))
    expect(fs.readFileSync(result.path!)).toEqual(bytes)
  })
})
