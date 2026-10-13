import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateRemoteVideo } from '../remote-media-runtime'

/**
 * Remote video against a real HTTP server playing the provider's job API: submit, poll, preview,
 * content and cancel. The runtime's polling, download limits and cleanup all run for real.
 */

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64'
)
const clip = Buffer.from('fake mp4 bytes')
const request = {
  prompt: 'A red ball rolls across a table',
  negativePrompt: '',
  width: 832,
  height: 480,
  frames: 17,
  fps: 8,
  steps: 4,
  guidance: 6,
  seed: 42
}

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void
interface Seen {
  method: string
  url: string
  authorization?: string
  body: string
}

let server: Server
let endpoint: string
let directory: string
let output: string
let handler: Handler
let seen: Seen[]

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ogad-remote-video-'))
  output = path.join(directory, 'clip.mp4')
  seen = []
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString()
    seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body })
    handler(req, body, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server port')
  endpoint = `http://127.0.0.1:${address.port}/v1`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(directory, { recursive: true, force: true })
})

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function remoteServer(
  provider: 'ogad' | 'openrouter' | 'ollama',
  selectedModel = 'wan2.1'
): Parameters<typeof generateRemoteVideo>[0] {
  return {
    id: 'desk',
    name: 'Desk',
    provider,
    endpoint,
    model: selectedModel,
    selectedModel,
    apiKey: 'test-key',
    screenFramesAllowed: false
  } as Parameters<typeof generateRemoteVideo>[0]
}

/** An OGAD job that reports progress and a preview, then completes. */
function ogadJob(options: { content?: Buffer; fail?: string } = {}): Handler {
  let polls = 0
  return (req, _body, res) => {
    if (req.method === 'POST' && req.url === '/v1/videos') return json(res, 200, { request_id: 'job-1' })
    if (req.url === '/v1/videos/job-1') {
      polls += 1
      if (options.fail) return json(res, 200, { status: 'failed', error: { message: options.fail } })
      if (polls === 1)
        return json(res, 200, {
          status: 'running',
          stage: 'generating',
          progress: { step: 2, total: 4 },
          preview: { width: 832, height: 480 }
        })
      return json(res, 200, { status: 'completed' })
    }
    if (req.url === '/v1/videos/job-1/preview') {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      return res.end(png)
    }
    if (req.url === '/v1/videos/job-1/content') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' })
      return res.end(options.content ?? clip)
    }
    json(res, 404, { error: 'not found' })
  }
}

describe('remote video generation', () => {
  it('submits to OGAD, reports progress and a preview, and saves the finished clip', async () => {
    handler = ogadJob()
    const updates: Array<{ stage?: string; step?: number; preview?: string }> = []

    const effective = await generateRemoteVideo(
      remoteServer('ogad'),
      request,
      output,
      new AbortController().signal,
      (progress, stage, preview) =>
        updates.push({ stage, step: progress?.step, ...(preview ? { preview: preview.path } : {}) })
    )

    expect(effective).toEqual({})
    expect(await fs.readFile(output)).toEqual(clip)
    expect(await fs.readFile(`${output}.preview.png`)).toEqual(png)
    expect(updates).toEqual([
      { stage: 'generating', step: 2 },
      { stage: 'generating', step: 2, preview: `${output}.preview.png` },
      { stage: 'encoding', step: undefined }
    ])
    const submit = JSON.parse(seen[0]!.body)
    expect(submit).toMatchObject({ model: 'wan2.1', prompt: request.prompt, enhancePrompt: false })
    expect(typeof submit.client_job_id).toBe('string')
    // Every request carries the credential to the configured server, and only there.
    expect(seen.every((entry) => entry.authorization === 'Bearer test-key')).toBe(true)
  })

  it('reports the provider failure and leaves no partial file', async () => {
    handler = ogadJob({ fail: 'Out of GPU memory' })
    await expect(
      generateRemoteVideo(remoteServer('ogad'), request, output, new AbortController().signal)
    ).rejects.toThrow('Out of GPU memory')
    await expect(fs.access(output)).rejects.toThrow()
    // A failed job is also cancelled on the server (sent without waiting for the reply).
    await expect.poll(() => seen.some((entry) => entry.url === '/v1/videos/job-1/cancel')).toBe(true)
  })

  it('refuses an empty clip', async () => {
    handler = ogadJob({ content: Buffer.alloc(0) })
    await expect(
      generateRemoteVideo(remoteServer('ogad'), request, output, new AbortController().signal)
    ).rejects.toThrow('The remote server returned an empty video.')
    await expect(fs.access(output)).rejects.toThrow()
  })

  it('surfaces a submit error from the provider body', async () => {
    handler = (_req, _body, res) => json(res, 503, { error: { message: 'Video engine is busy' } })
    await expect(
      generateRemoteVideo(remoteServer('ogad'), request, output, new AbortController().signal)
    ).rejects.toThrow('Video engine is busy')
  })

  it('rejects a job response with no id', async () => {
    handler = (req, _body, res) =>
      req.method === 'POST' && req.url === '/v1/videos'
        ? json(res, 200, { request_id: 7 })
        : json(res, 404, {})
    await expect(
      generateRemoteVideo(remoteServer('ogad'), request, output, new AbortController().signal)
    ).rejects.toThrow('The server returned no video job ID.')
  })

  it('cancels the remote job when the user stops', async () => {
    const controller = new AbortController()
    handler = (req, _body, res) => {
      if (req.method === 'POST' && req.url === '/v1/videos') return json(res, 200, { request_id: 'job-1' })
      if (req.url === '/v1/videos/job-1') {
        controller.abort(new Error('Video generation stopped.'))
        return json(res, 200, { status: 'running', stage: 'generating', progress: { step: 1, total: 4 } })
      }
      json(res, 200, {})
    }
    await expect(
      generateRemoteVideo(remoteServer('ogad'), request, output, controller.signal)
    ).rejects.toThrow()
    await expect.poll(() => seen.some((entry) => entry.url === '/v1/videos/job-1/cancel')).toBe(true)
    await expect(fs.access(output)).rejects.toThrow()
  })

  it('maps an OpenRouter request to the model it offers and reports what it will make', async () => {
    handler = (req, _body, res) => {
      if (req.url === '/v1/videos/models')
        return json(res, 200, {
          data: [{ id: 'vendor/video', supported_durations: [4, 8], supported_sizes: ['832x480'], seed: true }]
        })
      if (req.method === 'POST' && req.url === '/v1/videos') return json(res, 200, { id: 'or-1' })
      if (req.url === '/v1/videos/or-1') return json(res, 200, { status: 'completed' })
      if (req.url === '/v1/videos/or-1/content') {
        res.writeHead(200, { 'Content-Type': 'video/mp4' })
        return res.end(clip)
      }
      json(res, 404, {})
    }
    const effective = await generateRemoteVideo(
      remoteServer('openrouter', 'vendor/video'),
      { ...request, frames: 49 },
      output,
      new AbortController().signal
    )
    expect(effective).toEqual({ width: 832, height: 480, frames: 64 })
    expect(JSON.parse(seen.find((entry) => entry.method === 'POST')!.body)).toMatchObject({
      duration: 8,
      size: '832x480',
      seed: 42
    })
    expect(await fs.readFile(output)).toEqual(clip)
  })

  it('refuses an OpenRouter model without video, and providers without a video API', async () => {
    handler = (_req, _body, res) => json(res, 200, { data: [{ id: 'other/model' }] })
    await expect(
      generateRemoteVideo(remoteServer('openrouter', 'vendor/video'), request, output, new AbortController().signal)
    ).rejects.toThrow('The selected OpenRouter model does not support video generation.')
    await expect(
      generateRemoteVideo(remoteServer('ollama'), request, output, new AbortController().signal)
    ).rejects.toThrow('Remote video generation requires an OGAD or OpenRouter server.')
  })
})
