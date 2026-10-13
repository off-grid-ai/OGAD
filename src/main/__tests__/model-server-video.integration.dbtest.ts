/**
 * Real HTTP and SQLite integration for the gateway's video jobs: /v1/videos submit, poll,
 * content and cancel, plus recovery of jobs a previous run left unfinished.
 *
 * The bundled `sd-cli` and `ffmpeg` executables are the only stand-ins. The gateway, job service,
 * modality queue, argument builder and file handling are the production code.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const fixture = (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-gateway-video-'))
  return { root, dataDir: path.join(root, 'data'), binDir: path.join(root, 'bin') }
})()

vi.mock('electron', () => ({
  app: {
    getPath: () => fixture.dataDir,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => 'test'
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

const PACK = ['wan2.1_t2v_1.3B_fp16.safetensors', 'wan_2.1_vae.safetensors', 'umt5-xxl-encoder-Q4_K_M.gguf']

/** sd-cli prints the engine's progress format and writes a clip; FAKE_SD_MODE=slow never finishes. */
const FAKE_SD_CLI = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args.includes('--help')) { process.stdout.write('usage: sd-cli\\n'); process.exit(0) }
if (args.includes('--list-devices')) process.exit(0)
const value = (flag) => args[args.indexOf(flag) + 1]
const steps = Number(value('--steps'))
let step = 0
const tick = () => {
  if (process.env.FAKE_SD_MODE === 'slow') return setTimeout(tick, 50)
  step += 1
  process.stderr.write('  | ' + step + '/' + steps + ' - 0.10s/it\\r')
  if (step < steps) return setTimeout(tick, 5)
  process.stderr.write('OFFGRID_VIDEO_DECODE 1 1\\n')
  fs.writeFileSync(value('-o'), 'synthetic clip')
  process.exit(0)
}
process.on('SIGTERM', () => process.exit(143))
tick()
`
const FAKE_FFMPEG = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args.includes('-encoders')) { process.stdout.write(' V....D libx264  H.264 / AVC\\n'); process.exit(0) }
fs.copyFileSync(args[args.indexOf('-i') + 1], args.at(-1))
`

/** What the gateway answers about a video job. */
interface JobBody {
  request_id: string
  kind?: string
  status?: string
  poll_url?: string
  result?: { url?: string; steps?: number }
  error?: { message?: string; type?: string }
  cancelled?: boolean
}

/** A job a previous run left running, which this run must report as interrupted. */
const INTERRUPTED_ID = 'interrupted-job-0000000001'

let base: string
let stopModelServer: () => void

function install(dir: string, name: string, source: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), source, { mode: 0o755 })
}

async function unusedPort(): Promise<number> {
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

async function post(route: string, body: unknown): Promise<{ status: number; body: JobBody }> {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: response.status, body: (await response.json()) as JobBody }
}

async function poll(id: string): Promise<JobBody> {
  return (await (await fetch(`${base}/v1/videos/${id}`)).json()) as JobBody
}

async function settled(id: string): Promise<JobBody> {
  let job: JobBody = { request_id: id }
  await vi.waitFor(
    async () => {
      job = await poll(id)
      expect(['completed', 'failed']).toContain(job.status)
    },
    { timeout: 10_000, interval: 20 }
  )
  return job
}

beforeAll(async () => {
  fs.mkdirSync(path.join(fixture.dataDir, 'models'), { recursive: true })
  for (const name of PACK) fs.writeFileSync(path.join(fixture.dataDir, 'models', name), 'weights')
  install(path.join(fixture.binDir, 'sd'), 'sd-cli', FAKE_SD_CLI)
  install(fixture.binDir, 'ffmpeg', FAKE_FFMPEG)
  fs.writeFileSync(
    path.join(fixture.dataDir, 'video-api-jobs.json'),
    JSON.stringify([
      { id: INTERRUPTED_ID, kind: 'video', collection: '/v1/videos', status: 'running', created_at: 1, updated_at: 1, stage: 'generating' },
      null,
      { id: 'not-a-video', kind: 'image', status: 'queued' }
    ])
  )
  const { configureRuntime } = await import('../runtime-env')
  configureRuntime({
    dataDir: fixture.dataDir,
    modelsDir: path.join(fixture.dataDir, 'models'),
    binRoots: [fixture.binDir]
  })
  const modelServer = await import('../model-server')
  stopModelServer = modelServer.stopModelServer
  const port = await unusedPort()
  modelServer.startModelServer(port)
  base = `http://127.0.0.1:${String(port)}`
  await vi.waitFor(async () => expect((await fetch(`${base}/v1`)).ok).toBe(true), { timeout: 2000 })
})

beforeEach(() => {
  delete process.env.FAKE_SD_MODE
})

afterAll(() => {
  stopModelServer()
  fs.rmSync(fixture.root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('model gateway video jobs', () => {
  it('reports a job the previous run left unfinished as interrupted, and keeps that answer', async () => {
    expect(await poll(INTERRUPTED_ID)).toMatchObject({
      status: 'failed',
      error: { type: 'interrupted' }
    })
    const saved = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'video-api-jobs.json'), 'utf8'))
    expect(saved.find((job: { id: string }) => job.id === INTERRUPTED_ID)).toMatchObject({ status: 'failed' })
  })

  it('accepts a clip request, reports progress, and serves the finished MP4', async () => {
    const clientJobId = 'client-job-0000000000000001'
    const submitted = await post('/v1/videos', {
      prompt: 'A red ball rolls across a table',
      steps: 4,
      client_job_id: clientJobId
    })
    expect(submitted.status).toBe(202)
    expect(submitted.body).toMatchObject({ request_id: clientJobId, kind: 'video', poll_url: `/v1/videos/${clientJobId}` })

    const job = await settled(clientJobId)
    expect(job).toMatchObject({ status: 'completed', result: { url: `/v1/videos/${clientJobId}/content`, steps: 4 } })

    const content = await fetch(`${base}/v1/videos/${clientJobId}/content`)
    expect(content.status).toBe(200)
    expect(content.headers.get('content-type')).toBe('video/mp4')
    expect(await content.text()).toBe('synthetic clip')

    // A retried submit with the same id and body is the same job; a different body is refused.
    expect((await post('/v1/videos', { prompt: 'A red ball rolls across a table', steps: 4, client_job_id: clientJobId })).body)
      .toMatchObject({ request_id: clientJobId, status: 'completed' })
    expect(await post('/v1/videos', { prompt: 'Something else', steps: 4, client_job_id: clientJobId })).toMatchObject({
      status: 400,
      body: { error: { message: 'This job id belongs to a different request.' } }
    })
  })

  it('stops a running clip on request and reports it as cancelled', async () => {
    process.env.FAKE_SD_MODE = 'slow'
    const { body } = await post('/v1/videos', { prompt: 'A slow pan over a lake', steps: 4 })
    const id = body.request_id
    await vi.waitFor(async () => expect((await poll(id)).status).toBe('running'), { timeout: 5000 })
    // Nothing to show yet: no frame has been decoded.
    expect((await fetch(`${base}/v1/videos/${id}/preview`)).status).toBe(404)
    expect((await fetch(`${base}/v1/videos/${id}/content`)).status).toBe(404)

    expect((await post(`/v1/videos/${id}/cancel`, {})).body).toEqual({ cancelled: true })
    const job = await settled(id)
    expect(job).toMatchObject({ status: 'failed', error: { type: 'cancelled' } })
    // A finished job has nothing left to stop.
    expect((await post(`/v1/videos/${id}/cancel`, {})).body).toEqual({ cancelled: false })
  })

  it('runs the same jobs for an MCP client: start, follow, and stop', async () => {
    const client = new Client({ name: 'video-test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)))
    try {
      const text = (result: unknown): JobBody =>
        JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text)

      const started = text(await client.callTool({ name: 'generate_video', arguments: { prompt: 'Waves at dusk', steps: 4 } }))
      expect(started).toMatchObject({ poll_url: `/v1/videos/${started.request_id}` })
      const done = await settled(started.request_id)
      expect(done).toMatchObject({ status: 'completed' })
      expect(text(await client.callTool({ name: 'video_generation_status', arguments: { job_id: started.request_id } })))
        .toMatchObject({ status: 'completed', result: { url: `/v1/videos/${started.request_id}/content` } })

      process.env.FAKE_SD_MODE = 'slow'
      const slow = text(await client.callTool({ name: 'generate_video', arguments: { prompt: 'Slow waves', steps: 4 } }))
      await vi.waitFor(async () => expect((await poll(slow.request_id)).status).toBe('running'), { timeout: 5000 })
      await client.callTool({ name: 'video_generation_status', arguments: { job_id: slow.request_id, cancel: true } })
      expect(await settled(slow.request_id)).toMatchObject({ status: 'failed', error: { type: 'cancelled' } })

      const missing = await client.callTool({ name: 'video_generation_status', arguments: { job_id: 'no-such-job' } })
      expect(missing).toMatchObject({ isError: true })
    } finally {
      await client.close()
    }
  })

  it('refuses malformed requests before any work starts', async () => {
    const refusals = await Promise.all([
      post('/v1/videos', { prompt: 'lake', client_job_id: 'short' }),
      post('/v1/videos', { prompt: 'lake', use_remote: 'yes' }),
      post('/v1/videos', { prompt: 'lake', use_remote: true }),
      post('/v1/videos', { prompt: 'lake', steps: 4.5 })
    ])
    expect(refusals.map((refusal) => refusal.status)).toEqual([400, 400, 400, 400])
    expect(refusals.map((refusal) => refusal.body.error?.message).slice(0, 3)).toEqual([
      'Invalid video client job id.',
      'use_remote must be a boolean.',
      'Select an OpenRouter video model before using remote generation.'
    ])
    for (const route of ['content', 'preview']) {
      expect((await fetch(`${base}/v1/videos/missing-job/${route}`)).status).toBe(404)
    }
    expect((await post('/v1/videos/missing-job/cancel', {})).status).toBe(404)
  })
})
