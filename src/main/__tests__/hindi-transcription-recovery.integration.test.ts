import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureRuntime } from '../runtime-env'
import { transcriptionService } from '../transcription/whisper-cli'
import { HINDI_SCRIPT_RECOVERY_MESSAGE } from '@offgrid/models'

describe('Hindi transcription native recovery journey', () => {
  let root = ''
  let binDir = ''
  let modelsDir = ''
  let wavPath = ''
  let logPath = ''

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-hindi-recovery-'))
    binDir = path.join(root, 'bin')
    modelsDir = path.join(root, 'data', 'models')
    wavPath = path.join(root, 'speech.wav')
    logPath = path.join(root, 'whisper-args.jsonl')
    fs.mkdirSync(path.join(binDir, 'whisper'), { recursive: true })
    fs.mkdirSync(modelsDir, { recursive: true })
    fs.writeFileSync(wavPath, 'wav')
    const whisper = path.join(binDir, 'whisper', 'whisper-cli')
    fs.writeFileSync(
      whisper,
      `#!/usr/bin/env node
const fs = require('fs')
fs.appendFileSync(process.env.OFFGRID_TEST_WHISPER_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
const model = process.argv[process.argv.indexOf('-m') + 1]
process.stdout.write(model.includes('medium') ? 'नमस्ते, आप कैसे हैं?' : 'Thalo, How are you?')
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

  it('forces Hindi decoding and retries with a stronger installed multilingual model', async () => {
    fs.writeFileSync(path.join(modelsDir, 'ggml-base.bin'), 'model')
    fs.writeFileSync(path.join(modelsDir, 'ggml-medium.bin'), 'model')

    const result = await transcriptionService.transcribe(
      { path: wavPath },
      { language: 'hi', model: 'ggml-base.bin', alreadyWav16k: true }
    )

    expect(result.text).toBe('नमस्ते, आप कैसे हैं?')
    const calls = fs
      .readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    expect(calls).toHaveLength(2)
    expect(calls.map((args) => path.basename(args[args.indexOf('-m') + 1]!))).toEqual([
      'ggml-base.bin',
      'ggml-medium.bin'
    ])
    for (const args of calls) {
      expect(args.slice(args.indexOf('-l'), args.indexOf('-l') + 2)).toEqual(['-l', 'hi'])
      expect(args[args.indexOf('--prompt') + 1]).toMatch(/\p{Script=Devanagari}/u)
    }
  })

  it('returns an actionable result instead of accepting Latin-script Hindi', async () => {
    fs.writeFileSync(path.join(modelsDir, 'ggml-base.bin'), 'model')

    await expect(
      transcriptionService.transcribe(
        { path: wavPath },
        { language: 'hi', model: 'ggml-base.bin', alreadyWav16k: true }
      )
    ).rejects.toThrow(HINDI_SCRIPT_RECOVERY_MESSAGE)
    expect(fs.readFileSync(logPath, 'utf8').trim().split('\n')).toHaveLength(1)
  })
})
