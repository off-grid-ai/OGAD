// Parakeet and Qwen3-ASR picks transcribe through the app's own transcription seam: the active
// model chooses the engine, a long recording goes in pieces cut at its pauses, and each engine is
// launched the way it loads its model. The native engines are the boundary: a sherpa-onnx CLI that
// reports the length of each wav it is given, and a llama-server that answers chat requests the way
// Qwen3-ASR does. Selection, chunking, launch arguments, requests and parsing are real.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { CATALOG } from '@offgrid/models'
import { binRoots, configureRuntime, dataDir, modelsDir } from '../../runtime-env'
import { getLocalTranscription } from '../select'
import { qwen3AsrTranscription } from '../qwen3-asr'
import { encodeWav } from '../wav'

const previous = { dataDir: dataDir(), binRoots: binRoots(), modelsDir: modelsDir() }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-speech-engines-'))
const bin = path.join(profile, 'bin')
const models = path.join(profile, 'models')
const sherpaLog = path.join(profile, 'sherpa.log')
const llamaLog = path.join(profile, 'llama.log')
configureRuntime({ dataDir: profile, binRoots: [bin], modelsDir: models })

const PARAKEET = 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8'
const QWEN = 'ggml-org/Qwen3-ASR-1.7B-GGUF'

/** Seconds of 16 kHz 16-bit mono audio in a WAV of this many bytes (44-byte header). */
const SECONDS = `const seconds = (bytes) => ((bytes - 44) / 32000).toFixed(2) + ' seconds'`

function install(file: string, source: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, source, { mode: 0o755 })
}

install(
  path.join(bin, 'parakeet', 'bin', 'sherpa-onnx-offline'),
  `#!/usr/bin/env node
const fs = require('node:fs');
${SECONDS};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(sherpaLog)}, JSON.stringify(args) + '\\n');
for (const wav of args.filter((arg) => !arg.startsWith('--'))) {
  process.stderr.write(wav + '\\n');
  process.stdout.write(JSON.stringify({ lang: '', emotion: '', event: '', text: seconds(fs.statSync(wav).size) }) + '\\n');
}
`
)
install(
  path.join(bin, 'llama-cpu', 'llama-server'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
${SECONDS};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(llamaLog)}, JSON.stringify({ launch: args }) + '\\n');
const port = Number(args[args.indexOf('--port') + 1]);
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok' }));
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const request = JSON.parse(body);
    const audio = request.messages[0].content[0].input_audio;
    const prefill = request.messages[1]?.content;
    fs.appendFileSync(${JSON.stringify(llamaLog)}, JSON.stringify({ format: audio.format, prefill, temperature: request.temperature }) + '\\n');
    const heard = seconds(Buffer.from(audio.data, 'base64').length);
    // Started by the request, the answer continues after the mark; otherwise the model names the language.
    const content = prefill ? heard : 'language English<asr_text>' + heard;
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`
)

// Every file the two catalog picks download, so the app sees them installed.
fs.mkdirSync(models, { recursive: true })
for (const id of [PARAKEET, QWEN]) {
  const entry = CATALOG.find((model) => model.id === id)!
  for (const file of entry.files) fs.writeFileSync(path.join(models, file.name), 'weights')
}

/** 70 s of tone with two short pauses, at 24.9-25.2 s and 51.9-52.2 s. */
const recording = path.join(profile, 'meeting.wav')
const samples = new Float32Array(70 * 16_000)
for (let i = 0; i < samples.length; i++) {
  const t = i / 16_000
  const pause = (t >= 24.9 && t < 25.2) || (t >= 51.9 && t < 52.2)
  samples[i] = pause ? 0 : 0.3 * Math.sin(2 * Math.PI * 220 * t)
}
fs.writeFileSync(recording, encodeWav(samples, 16_000))

function choose(id: string): void {
  fs.writeFileSync(
    path.join(models, 'active-modalities.json'),
    JSON.stringify({ transcription: id })
  )
}
const lines = (file: string): unknown[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []

beforeEach(() => {
  fs.rmSync(sherpaLog, { force: true })
  fs.rmSync(llamaLog, { force: true })
})

afterAll(async () => {
  qwen3AsrTranscription.stop()
  configureRuntime(previous)
  await new Promise((resolve) => setTimeout(resolve, 200))
  fs.rmSync(profile, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('Parakeet and Qwen3-ASR picks', () => {
  it('a Parakeet pick runs the sherpa-onnx CLI as a NeMo transducer, a long recording in pieces cut at its pauses', async () => {
    choose(PARAKEET)
    const transcript = await getLocalTranscription(() => 'auto').transcribe(
      { path: recording },
      { alreadyWav16k: true, timestamps: true }
    )

    expect(transcript.text).toBe('24.95 seconds 27.05 seconds 18.00 seconds')
    expect(transcript.segments?.map((segment) => [segment.start, segment.end])).toEqual([
      [0, 24.95],
      [24.95, 52],
      [52, 70]
    ])
    const runs = lines(sherpaLog) as string[][]
    expect(runs).toHaveLength(1) // three pieces, one model load
    expect(runs[0]).toEqual(
      expect.arrayContaining([
        '--model-type=nemo_transducer',
        `--encoder=${path.join(models, 'parakeet-v2.encoder.int8.onnx')}`,
        `--decoder=${path.join(models, 'parakeet-v2.decoder.int8.onnx')}`,
        `--joiner=${path.join(models, 'parakeet-v2.joiner.int8.onnx')}`,
        `--tokens=${path.join(models, 'parakeet-v2.tokens.txt')}`
      ])
    )
    expect(runs[0]!.filter((arg) => arg.endsWith('.wav'))).toHaveLength(3)
  })

  it('a Qwen3-ASR pick runs on llama-server with its audio projector, and a pinned language starts each answer', async () => {
    choose(QWEN)
    const transcript = await getLocalTranscription(() => 'en').transcribe(
      { path: recording },
      { alreadyWav16k: true }
    )

    expect(transcript).toEqual({
      text: '24.95 seconds 27.05 seconds 18.00 seconds',
      language: 'en'
    })
    const [launch, ...requests] = lines(llamaLog) as Array<Record<string, unknown>>
    const argv = launch!.launch as string[]
    expect(argv[argv.indexOf('-m') + 1]).toBe(path.join(models, 'Qwen3-ASR-1.7B-Q8_0.gguf'))
    expect(argv[argv.indexOf('--mmproj') + 1]).toBe(
      path.join(models, 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf')
    )
    expect(argv.slice(-2)).toEqual(['--cache-ram', '0'])
    expect(requests).toEqual(
      Array(3).fill({ format: 'wav', prefill: 'language English<asr_text>', temperature: 0 })
    )
  })

  it('with no language pinned, Qwen3-ASR names the language it heard', async () => {
    choose(QWEN)
    const transcript = await getLocalTranscription(() => 'auto').transcribe(
      { path: recording },
      { alreadyWav16k: true }
    )

    expect(transcript).toEqual({
      text: '24.95 seconds 27.05 seconds 18.00 seconds',
      language: 'en'
    })
    // The server from the last test is still warm: no second launch, three requests, no prefill.
    expect(lines(llamaLog)).toEqual(Array(3).fill({ format: 'wav', temperature: 0 }))
  })
})
