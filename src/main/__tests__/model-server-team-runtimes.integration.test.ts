/**
 * Team gateway mode across runtimes, over real HTTP. The fakes sit only at the native process
 * boundary: whisper-cli, ffmpeg and sd-cli are small scripts that log when each run starts and
 * ends, and llama-server is a loopback server on its production port. Everything between (the
 * gateway, transcription and image orchestration, the modality queue, the limiters) is real.
 *
 * Single mode keeps today's behaviour: transcriptions are not queued at all, images one at a time.
 * Team mode runs transcriptions side by side up to the RAM rule, queues the rest fairly and refuses
 * the overflow with 429, keeps images one at a time in a fair line, and lets a chat stream and a
 * transcription run at once.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { LLAMA_SERVER_PORT } from '../../shared/ports'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-gateway-team-runtimes-'))
const dataDir = path.join(root, 'data')
const binDir = path.join(root, 'bin')
const runLog = path.join(root, 'runs.log')

vi.mock('electron', () => ({
  app: {
    getPath: () => dataDir,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => 'test'
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const IMAGE_MODEL = 'team-image-fixture.safetensors'

/** A native-process fake: logs start and end with the run's kind, takes `ms`, then does `finish`. */
function installProcess(relative: string, kind: string, ms: number, finish: string): void {
  const file = path.join(binDir, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]
const id = Math.random().toString(36).slice(2)
fs.appendFileSync(${JSON.stringify(runLog)}, '${kind} start ' + id + ' ' + Date.now() + '\\n')
// The picture an image run was handed, by content (image-to-image).
if (args.includes('-i'))
  fs.appendFileSync(${JSON.stringify(runLog)}, 'init ' + require('node:crypto').createHash('sha256').update(fs.readFileSync(value('-i'))).digest('hex') + '\\n')
setTimeout(() => {
  fs.appendFileSync(${JSON.stringify(runLog)}, '${kind} end ' + id + ' ' + Date.now() + '\\n')
  ${finish}
}, Number(process.env.OFFGRID_FAKE_RUN_MS || ${ms}))
`
  )
  fs.chmodSync(file, 0o755)
}

/** The most runs of `kind` that were in progress at the same moment. */
function peak(kind: string): number {
  if (!fs.existsSync(runLog)) return 0
  let running = 0
  let most = 0
  for (const line of fs.readFileSync(runLog, 'utf8').trim().split('\n')) {
    const [k, event] = line.split(' ')
    if (k !== kind) continue
    running += event === 'start' ? 1 : -1
    most = Math.max(most, running)
  }
  return most
}

function runs(kind: string): number {
  if (!fs.existsSync(runLog)) return 0
  return fs
    .readFileSync(runLog, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith(`${kind} end`)).length
}

let gatewayPort: number
let upstream: http.Server
let holdChat: (() => void) | null = null
let llm: typeof import('../llm').llm
let teamConcurrency: typeof import('../model-server/team-runtimes').teamConcurrency
let stopModelServer: () => void

function transcribe(
  signal?: AbortSignal
): Promise<{ status: number; body: string; retryAfter: string | null }> {
  const form = new FormData()
  form.append('file', new Blob([Buffer.alloc(256, 1)], { type: 'audio/wav' }), 'note.wav')
  return fetch(`http://127.0.0.1:${gatewayPort}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
    signal
  }).then(async (response) => ({
    status: response.status,
    body: await response.text(),
    retryAfter: response.headers.get('retry-after')
  }))
}

function image(signal?: AbortSignal): Promise<{ status: number; body: string }> {
  return fetch(`http://127.0.0.1:${gatewayPort}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'A green cabin', model: IMAGE_MODEL }),
    signal
  }).then(async (response) => ({ status: response.status, body: await response.text() }))
}

/** An image-to-image request with `picture` as its upload. */
function edit(picture: Buffer): Promise<{ status: number; body: string }> {
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(picture)], { type: 'image/png' }), 'in.png')
  form.append('prompt', 'Make it autumn')
  form.append('model', IMAGE_MODEL)
  return fetch(`http://127.0.0.1:${gatewayPort}/v1/images/edits`, {
    method: 'POST',
    body: form
  }).then(async (response) => ({ status: response.status, body: await response.text() }))
}

function logLines(prefix: string): string[] {
  if (!fs.existsSync(runLog)) return []
  return fs.readFileSync(runLog, 'utf8').split('\n').filter((line) => line.startsWith(prefix))
}

async function waitFor(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function unusedPort(): Promise<number> {
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

beforeAll(async () => {
  process.env.OFFGRID_DATA_DIR = dataDir
  process.env.OFFGRID_BIN_DIR = binDir
  const models = path.join(dataDir, 'models')
  fs.mkdirSync(models, { recursive: true })
  fs.writeFileSync(path.join(models, 'ggml-base.bin'), 'synthetic whisper model')
  fs.writeFileSync(path.join(models, IMAGE_MODEL), 'fixture checkpoint')
  fs.copyFileSync(path.resolve('e2e/fixtures/hey-how-are-you-doing.wav'), path.join(root, 'e2e-voice.wav'))
  fs.mkdirSync(binDir, { recursive: true })
  fs.copyFileSync(path.resolve('e2e/fixtures/copy-ffmpeg.sh'), path.join(binDir, 'ffmpeg'))
  fs.chmodSync(path.join(binDir, 'ffmpeg'), 0o755)
  installProcess('whisper/whisper-cli', 'stt', 400, `process.stdout.write('Book a table by the river\\n')`)
  installProcess(
    'sd/sd-cli',
    'image',
    300,
    `fs.writeFileSync(value('-o'), Buffer.from('${PNG_BASE64}', 'base64'))`
  )

  // llama-server: one chat stream that stays open until the test lets it end.
  upstream = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"thinking"}}]}\n\n')
      holdChat = () => res.end('data: {"choices":[{"delta":{"content":" done"}}]}\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(LLAMA_SERVER_PORT, '127.0.0.1', () => resolve())
  })

  ;({ llm } = await import('../llm'))
  ;({ teamConcurrency } = await import('../model-server/team-runtimes'))
  const gateway = await import('../model-server')
  stopModelServer = gateway.stopModelServer
  gatewayPort = await unusedPort()
  await gateway.startModelServer(gatewayPort)
})

afterEach(() => {
  fs.rmSync(runLog, { force: true })
  delete process.env.OFFGRID_FAKE_RUN_MS
})

afterAll(async () => {
  holdChat?.()
  stopModelServer()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  delete process.env.OFFGRID_DATA_DIR
  delete process.env.OFFGRID_BIN_DIR
  fs.rmSync(root, { recursive: true, force: true })
})

describe('single mode keeps every runtime as it is today', () => {
  it('runs transcriptions without a queue, as before', async () => {
    await llm.setSettings({ gatewayMode: 'single' })
    const results = await Promise.all(Array.from({ length: 4 }, () => transcribe()))
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200])
    expect(JSON.parse(results[0]!.body)).toMatchObject({ text: 'Book a table by the river' })
    expect(peak('stt')).toBe(4)
  })

  it('generates images one at a time', async () => {
    await llm.setSettings({ gatewayMode: 'single' })
    const results = await Promise.all([image(), image()])
    expect(results.map((r) => r.status)).toEqual([200, 200])
    expect(peak('image')).toBe(1)
  })

  it('hands each of two same-size image edits its own picture', async () => {
    await llm.setSettings({ gatewayMode: 'single' })
    const sharp = (await import('sharp')).default
    const red = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toBuffer()
    const blue = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0000ff' } }).png().toBuffer()
    // Same size on the wire: PNG readers ignore bytes after the image end.
    const size = Math.max(red.length, blue.length)
    const pad = (picture: Buffer): Buffer => Buffer.concat([picture, Buffer.alloc(size - picture.length)])
    const pictures = [pad(red), pad(blue)]
    const results = await Promise.all(pictures.map((picture) => edit(picture)))
    expect(results.map((r) => r.status)).toEqual([200, 200])
    const handed = logLines('init ').map((line) => line.split(' ')[1])
    const sent = pictures.map((picture) => createHash('sha256').update(picture).digest('hex'))
    expect(handed.sort()).toEqual(sent.sort())
  })
})

describe('team mode', () => {
  it('runs as many transcriptions at once as the RAM rule allows and queues the next', async () => {
    await llm.setSettings({ gatewayMode: 'team' })
    const workers = teamConcurrency().transcription
    const results = await Promise.all(Array.from({ length: workers + 1 }, () => transcribe()))
    expect(results.every((r) => r.status === 200)).toBe(true)
    expect(runs('stt')).toBe(workers + 1)
    expect(peak('stt')).toBe(workers)
  })

  it('refuses transcriptions past the bounded line with 429 and Retry-After', async () => {
    await llm.setSettings({ gatewayMode: 'team' })
    const workers = teamConcurrency().transcription
    const results = await Promise.all(
      Array.from({ length: workers + workers * 4 + 2 }, () => transcribe())
    )
    const refused = results.filter((r) => r.status === 429)
    expect(refused.length).toBeGreaterThan(0)
    expect(refused[0]!.retryAfter).toBe('2')
    expect(JSON.parse(refused[0]!.body)).toMatchObject({ error: { type: 'rate_limit_error' } })
    expect(results.filter((r) => r.status === 200)).toHaveLength(workers + workers * 4)
  })

  it('keeps image generation one at a time in a fair line', async () => {
    await llm.setSettings({ gatewayMode: 'team' })
    const results = await Promise.all([image(), image(), image()])
    expect(results.map((r) => r.status)).toEqual([200, 200, 200])
    expect(peak('image')).toBe(1)
  })

  it('a client that leaves stops its image, and the next request takes the turn', async () => {
    await llm.setSettings({ gatewayMode: 'team' })
    process.env.OFFGRID_FAKE_RUN_MS = '4000'
    const leaving = new AbortController()
    const first = image(leaving.signal).catch((error: unknown) => error)
    await waitFor(() => logLines('image start').length === 1, 'the first image to start')
    leaving.abort()
    await first
    process.env.OFFGRID_FAKE_RUN_MS = '200'
    const startedAt = Date.now()
    const next = await image()
    expect(next.status).toBe(200)
    // It did not wait out the first image's four seconds.
    expect(Date.now() - startedAt).toBeLessThan(3_000)
    expect(runs('image')).toBe(1)
  })

  it('transcribes while a chat stream is still open', async () => {
    await llm.setSettings({ gatewayMode: 'team' })
    holdChat = null
    const chat = fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] })
    }).then((response) => response.text())
    const deadline = Date.now() + 3_000
    while (!holdChat && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    expect(holdChat).not.toBeNull()
    const transcription = await transcribe()
    expect(transcription.status).toBe(200)
    // The stream is still open: the transcription did not wait behind it.
    holdChat!()
    expect(await chat).toContain('done')
  })
})

describe('team mode with a resident whisper-server installed', () => {
  beforeAll(() => {
    // whisper-server: loads its model once at start (logged as a spawn), then serves /inference.
    const file = path.join(binDir, 'whisper-server', 'whisper-server')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
fs.appendFileSync(${JSON.stringify(runLog)}, 'spawn server ' + port + ' ' + Date.now() + '\\n')
http.createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('ok'); return }
  req.resume()
  req.on('end', () => {
    const id = Math.random().toString(36).slice(2)
    fs.appendFileSync(${JSON.stringify(runLog)}, 'lane start ' + id + ' ' + Date.now() + '\\n')
    setTimeout(() => {
      fs.appendFileSync(${JSON.stringify(runLog)}, 'lane end ' + id + ' ' + Date.now() + '\\n')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ text: 'Book a table on a lane' }))
    }, Number(process.env.OFFGRID_FAKE_RUN_MS || 400))
  })
}).listen(port, '127.0.0.1')
`
    )
    fs.chmodSync(file, 0o755)
  })

  it('transcribes on resident lanes, one model load per lane, never a process per request', async () => {
    await llm.setSettings({ gatewayMode: 'team' })
    const workers = teamConcurrency().transcription
    const first = await Promise.all(Array.from({ length: workers + 1 }, () => transcribe()))
    const second = await Promise.all(Array.from({ length: workers }, () => transcribe()))
    for (const result of [...first, ...second]) {
      expect(result.status).toBe(200)
      expect(JSON.parse(result.body)).toMatchObject({ text: 'Book a table on a lane' })
    }
    expect(peak('lane')).toBe(workers)
    expect(runs('stt')).toBe(0)
    const spawns = fs.readFileSync(runLog, 'utf8').split('\n').filter((line) => line.startsWith('spawn server'))
    expect(spawns).toHaveLength(workers)
  })

  it('a client that leaves frees its transcription lane for the next request', async () => {
    await llm.setSettings({ gatewayMode: 'team' })
    process.env.OFFGRID_FAKE_RUN_MS = '3000'
    // Lanes start again with the slower engine.
    const { whisperServer } = await import('../transcription/whisper-server')
    const { stopTeamLanes } = await import('../transcription/team-lanes')
    stopTeamLanes()
    whisperServer.stop()
    const workers = teamConcurrency().transcription
    const leaving = new AbortController()
    const first = transcribe(leaving.signal).catch((error: unknown) => error)
    const others = Array.from({ length: workers - 1 }, () => transcribe())
    await waitFor(() => logLines('lane start').length === workers, 'every lane to be busy')
    leaving.abort()
    await first
    const next = transcribe()
    // The freed lane takes the next request while the others are still running.
    await waitFor(() => logLines('lane start').length === workers + 1, 'the next request to start')
    expect(logLines('lane end')).toHaveLength(0)
    for (const result of await Promise.all([next, ...others])) expect(result.status).toBe(200)
  })

  it('counts its extra lanes in the memory planner and frees them with the resident server', async () => {
    await llm.setSettings({ gatewayMode: 'team' })
    const workers = teamConcurrency().transcription
    await Promise.all(Array.from({ length: workers }, () => transcribe()))
    await Promise.all(Array.from({ length: workers }, () => transcribe()))
    const { sttRuntime } = await import('../transcription/select')
    const { whisperServer } = await import('../transcription/whisper-server')
    // Every lane holds its own copy of the model.
    expect(sttRuntime.footprintMB!()).toBe(whisperServer.residentMB() * workers)
    await sttRuntime.evict()
    expect(sttRuntime.footprintMB!()).toBe(0)
  })

  afterAll(async () => {
    const { whisperServer } = await import('../transcription/whisper-server')
    const { stopTeamLanes } = await import('../transcription/team-lanes')
    stopTeamLanes()
    whisperServer.stop()
  })
})

