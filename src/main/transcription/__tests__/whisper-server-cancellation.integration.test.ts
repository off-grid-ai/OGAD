import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { WhisperServerService } from '../whisper-server'
import { WhisperServerTranscription } from '../whisper-server-transcription'

const previousBinDir = process.env.OFFGRID_BIN_DIR
const previousTrace = process.env.OFFGRID_WHISPER_TEST_TRACE
const previousState = process.env.OFFGRID_WHISPER_TEST_STATE

async function availablePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return port
}

async function waitFor<T>(read: () => T | null, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== null) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out while waiting for the native Whisper boundary.')
}

function installWhisperBoundary(root: string): { trace: string; state: string } {
  const binDir = path.join(root, 'bin')
  const runtimeDir = path.join(binDir, 'whisper-server')
  const trace = path.join(root, 'trace.log')
  const state = path.join(root, 'state.txt')
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.writeFileSync(
    path.join(runtimeDir, 'whisper-server'),
    `#!/usr/bin/env node
const fs = require('fs')
const http = require('http')
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
const trace = process.env.OFFGRID_WHISPER_TEST_TRACE
const state = process.env.OFFGRID_WHISPER_TEST_STATE
const append = (event) => fs.appendFileSync(trace, JSON.stringify({ event, pid: process.pid }) + '\\n')
const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200).end('ready')
    return
  }
  req.resume()
  req.on('end', () => {
    const count = Number(fs.existsSync(state) ? fs.readFileSync(state, 'utf8') : '0')
    fs.writeFileSync(state, String(count + 1))
    append('inference')
    if (count === 0) return
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ text: 'later request works' }))
  })
})
server.listen(port, '127.0.0.1')
`,
    { mode: 0o755 }
  )
  process.env.OFFGRID_BIN_DIR = binDir
  process.env.OFFGRID_WHISPER_TEST_TRACE = trace
  process.env.OFFGRID_WHISPER_TEST_STATE = state
  return { trace, state }
}

function inferencePids(trace: string): number[] {
  if (!fs.existsSync(trace)) return []
  return fs
    .readFileSync(trace, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; pid: number })
    .filter((entry) => entry.event === 'inference')
    .map((entry) => entry.pid)
}

afterEach(() => {
  if (previousBinDir === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = previousBinDir
  if (previousTrace === undefined) delete process.env.OFFGRID_WHISPER_TEST_TRACE
  else process.env.OFFGRID_WHISPER_TEST_TRACE = previousTrace
  if (previousState === undefined) delete process.env.OFFGRID_WHISPER_TEST_STATE
  else process.env.OFFGRID_WHISPER_TEST_STATE = previousState
})

describe('resident Whisper request cancellation', () => {
  it('stops active native inference and keeps the shared service usable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-whisper-cancel-'))
    const { trace } = installWhisperBoundary(root)
    const model = path.join(root, 'ggml-base.bin')
    const wav = path.join(root, 'voice.wav')
    fs.writeFileSync(model, 'synthetic model')
    fs.writeFileSync(wav, 'synthetic wav')
    const runtime = new WhisperServerService(await availablePort())
    const transcription = new WhisperServerTranscription(runtime)
    const controller = new AbortController()

    try {
      const first = transcription.transcribe(
        { path: wav },
        { model, alreadyWav16k: true, signal: controller.signal }
      )
      const firstPid = await waitFor(() => inferencePids(trace)[0] ?? null)
      const queued = transcription.transcribe({ path: wav }, { model, alreadyWav16k: true })

      controller.abort()

      await expect(first).rejects.toMatchObject({ name: 'AbortError' })
      await waitFor(() => {
        try {
          process.kill(firstPid, 0)
          return null
        } catch {
          return true
        }
      })
      await expect(queued).resolves.toMatchObject({ text: 'later request works' })
      expect(inferencePids(trace)).toHaveLength(2)
      expect(inferencePids(trace)[1]).not.toBe(firstPid)
    } finally {
      runtime.stop()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
