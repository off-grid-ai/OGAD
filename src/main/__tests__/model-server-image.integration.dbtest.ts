/**
 * Real HTTP and SQLite integration for the local OpenAI-compatible gateway image seam.
 *
 * The bundled sd-cli executable is the only fake. The production gateway,
 * image orchestration, modality queue, argument builder, filesystem persistence,
 * and response shaping all remain real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

const fixture = (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-gateway-image-'))
  return {
    root,
    dataDir: path.join(root, 'data'),
    binDir: path.join(root, 'bin')
  }
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

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const MODEL_NAME = 'gateway-image-fixture.safetensors'
const CLI_PATH = path.join(fixture.binDir, 'sd', 'sd-cli')

let gatewayPort: number
let startModelServer: (port?: number) => void
let stopModelServer: () => void

function installNativeRuntimeBoundary(): void {
  fs.mkdirSync(path.dirname(CLI_PATH), { recursive: true })
  fs.writeFileSync(
    CLI_PATH,
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]
const slow = value('-p') === 'A slow green cabin under stars'
const valid =
  (value('-p') === 'A green cabin under stars' || slow) &&
  value('-W') === '640' &&
  value('-H') === '384' &&
  value('--steps') === '7' &&
  value('-s') === '314'
if (!valid) process.exit(17)
process.stderr.write('1/7 - 0.01s/it\\n')
const finish = () => fs.writeFileSync(value('-o'), Buffer.from('${PNG_BASE64}', 'base64'))
if (slow) setTimeout(finish, 10000)
else finish()
`
  )
  fs.chmodSync(CLI_PATH, 0o755)
}

async function unusedPort(): Promise<number> {
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

async function waitForGateway(): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(gatewayPort)}/v1`)
      if (response.ok) return
    } catch {
      // The listen callback has not fired yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('gateway did not start')
}

beforeAll(async () => {
  process.env.OFFGRID_DATA_DIR = fixture.dataDir
  process.env.OFFGRID_BIN_DIR = fixture.binDir
  fs.mkdirSync(path.join(fixture.dataDir, 'models'), { recursive: true })
  fs.writeFileSync(path.join(fixture.dataDir, 'models', MODEL_NAME), 'fixture checkpoint')
  installNativeRuntimeBoundary()

  const modelServer = await import('../model-server')
  startModelServer = modelServer.startModelServer
  stopModelServer = modelServer.stopModelServer
  gatewayPort = await unusedPort()
  startModelServer(gatewayPort)
  await waitForGateway()
})

beforeEach(() => {
  installNativeRuntimeBoundary()
})

afterAll(() => {
  stopModelServer()
  delete process.env.OFFGRID_DATA_DIR
  delete process.env.OFFGRID_BIN_DIR
  fs.rmSync(fixture.root, { recursive: true, force: true })
})

describe('model gateway image generation', () => {
  it('routes an image request through production orchestration and returns OpenAI data', async () => {
    const response = await fetch(`http://127.0.0.1:${String(gatewayPort)}/v1/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'A green cabin under stars',
        width: 640,
        height: 384,
        steps: 7,
        seed: 314,
        model: MODEL_NAME,
        response_format: 'b64_json'
      })
    })

    const body = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('x-request-id')).toBeTruthy()
    expect(body).toMatchObject({
      data: [
        {
          b64_json: PNG_BASE64,
          revised_prompt: 'A green cabin under stars',
          seed: 314,
          model: MODEL_NAME
        }
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    })

    const generated = fs
      .readdirSync(path.join(fixture.dataDir, 'generated-images'))
      .filter((name) => /^img-.*\.png$/.test(name))
    expect(generated).toHaveLength(1)
    expect(
      fs
        .readFileSync(path.join(fixture.dataDir, 'generated-images', generated[0]!))
        .toString('base64')
    ).toBe(PNG_BASE64)
  })

  it('returns an actionable unavailable response when the native runtime is absent', async () => {
    fs.rmSync(CLI_PATH)

    const response = await fetch(`http://127.0.0.1:${String(gatewayPort)}/v1/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'A green cabin under stars' })
    })

    expect(response.status).toBe(501)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({
      error: {
        message: 'Image generation unavailable: no image runtime found.',
        type: 'not_installed'
      }
    })
  })

  it('stops synchronous image work when the client disconnects', async () => {
    const base = `http://127.0.0.1:${String(gatewayPort)}`
    const before = await (await fetch(`${base}/v1/requests`)).json()
    const existing = new Set(before.data.map((entry: { request_id: string }) => entry.request_id))
    const controller = new AbortController()
    const response = fetch(`${base}/v1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        prompt: 'A slow green cabin under stars',
        width: 640,
        height: 384,
        steps: 7,
        seed: 314,
        model: MODEL_NAME
      })
    }).catch((error: unknown) => error)
    const deadline = Date.now() + 8000
    let running: { request_id: string; progress?: { step: number } } | undefined
    while (Date.now() < deadline) {
      const recent = await (await fetch(`${base}/v1/requests`)).json()
      running = recent.data.find((entry: { request_id: string }) => !existing.has(entry.request_id))
      if (running) {
        running = await (await fetch(`${base}/v1/requests/${running.request_id}`)).json()
      }
      if (running?.progress?.step === 1) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(running?.progress?.step).toBe(1)
    controller.abort()
    expect(await response).toMatchObject({ name: 'AbortError' })
    let cancelled: unknown
    const cancelDeadline = Date.now() + 2000
    while (Date.now() < cancelDeadline) {
      cancelled = await (await fetch(`${base}/v1/requests/${running!.request_id}`)).json()
      if ((cancelled as { status: string }).status === 'failed') break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(cancelled).toMatchObject({ status: 'failed', error: { type: 'cancelled' } })
  })

  it('cancels queued and running image requests without stopping another request', async () => {
    const base = `http://127.0.0.1:${String(gatewayPort)}`
    const submit = async (prompt: string): Promise<string> => {
      const response = await fetch(`${base}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          async: true,
          prompt,
          width: 640,
          height: 384,
          steps: 7,
          seed: 314,
          model: MODEL_NAME
        })
      })
      expect(response.status).toBe(202)
      return (await response.json()).request_id
    }
    const runningId = await submit('A slow green cabin under stars')
    const deadline = Date.now() + 8000
    let progress: { status: string; progress?: { step: number } } | undefined
    while (Date.now() < deadline) {
      progress = await (await fetch(`${base}/v1/requests/${runningId}`)).json()
      if (progress?.progress?.step === 1) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(progress).toMatchObject({ status: 'running', progress: { step: 1 } })

    const queuedId = await submit('A green cabin under stars')
    const cancelQueued = await fetch(`${base}/v1/requests/${queuedId}`, { method: 'DELETE' })
    expect(cancelQueued.status).toBe(200)
    expect(await cancelQueued.json()).toMatchObject({
      request_id: queuedId,
      status: 'failed',
      cancelled: true
    })
    expect(await (await fetch(`${base}/v1/requests/${runningId}`)).json()).toMatchObject({
      status: 'running'
    })

    for (let repeat = 0; repeat < 2; repeat++) {
      const cancelled = await fetch(`${base}/v1/requests/${runningId}`, { method: 'DELETE' })
      expect(cancelled.status).toBe(200)
      expect(await cancelled.json()).toMatchObject({
        request_id: runningId,
        status: 'failed',
        cancelled: true
      })
    }
    for (const id of [runningId, queuedId]) {
      expect(await (await fetch(`${base}/v1/requests/${id}`)).json()).toMatchObject({
        status: 'failed',
        error: { type: 'cancelled', message: 'Image generation cancelled.' }
      })
    }

    const completed = await fetch(`${base}/v1/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'A green cabin under stars',
        width: 640,
        height: 384,
        steps: 7,
        seed: 314,
        model: MODEL_NAME
      })
    })
    expect(completed.status).toBe(200)
    const result = await completed.json()
    expect(result.data[0].b64_json).toBe(PNG_BASE64)
    const cancelCompleted = await fetch(`${base}/v1/requests/${result.request_id}`, {
      method: 'DELETE'
    })
    expect(await cancelCompleted.json()).toMatchObject({ status: 'completed', cancelled: false })
    expect((await fetch(`${base}/v1/requests/missing`, { method: 'DELETE' })).status).toBe(404)
  })
})
