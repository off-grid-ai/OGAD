/**
 * Real HTTP integration for the local OpenAI-compatible gateway chat seam.
 *
 * The native llama-server process is the only fake: a loopback HTTP server speaks
 * its real SSE protocol on the production port. The production gateway must proxy
 * the first token before upstream completion, then preserve the rest of the stream.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'
import { encodeModelRouteId } from '@offgrid/models'
import { LLAMA_SERVER_PORT } from '../../shared/ports'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-gateway-chat-'))
const hostFetch = globalThis.fetch.bind(globalThis)

vi.mock('electron', () => ({
  app: {
    getPath: () => TMP_DIR,
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

let upstream: http.Server
let gatewayPort: number
let releaseUpstream: (() => void) | undefined
let upstreamRequest: Record<string, unknown> | undefined
let startModelServer: typeof import('../model-server').startModelServer
let stopModelServer: typeof import('../model-server').stopModelServer
const previousDataDir = process.env.OFFGRID_DATA_DIR

function installLlamaBoundary(source: string): string {
  const binRoot = path.join(TMP_DIR, 'test-bin')
  const executable = path.join(binRoot, 'llama', 'llama-server')
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(executable, `#!/usr/bin/env node\n${source}\n`)
  fs.chmodSync(executable, 0o755)
  return binRoot
}

function workingLlamaBoundary(reply = 'native model ready'): string {
  return `
const http = require('node:http')
const portArg = process.argv.indexOf('--port')
const port = Number(process.argv[portArg + 1])
const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok' }))
    return
  }
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'fixture-native-model' }] }))
    return
  }
  if (request.method === 'POST' && request.url === '/v1/chat/completions') {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: ${JSON.stringify(reply)} } }] }))
    })
    return
  }
  response.writeHead(404)
  response.end()
})
server.listen(port, '127.0.0.1')
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`
}

async function resetNativeJourney(llm: typeof import('../llm').llm): Promise<void> {
  await llm.unload()
  fs.rmSync(path.join(TMP_DIR, 'models'), { recursive: true, force: true })
  fs.mkdirSync(path.join(TMP_DIR, 'models'), { recursive: true })
  llm.reloadModel()
}

function fixtureDownload(url: string): Response {
  const bytes = Buffer.alloc(2048, 7)
  if (/\.gguf(?:\?|$)/i.test(url)) bytes.write('GGUF')
  return new Response(bytes, {
    status: 200,
    headers: { 'content-length': String(bytes.length) }
  })
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
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1`)
      if (response.ok) return
    } catch {
      // The listen callback has not fired yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('gateway did not start')
}

beforeAll(async () => {
  process.env.OFFGRID_DATA_DIR = TMP_DIR
  ;({ startModelServer, stopModelServer } = await import('../model-server'))
  upstream = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'fixture-chat' }] }))
      return
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404)
      res.end()
      return
    }

    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', async () => {
      upstreamRequest = JSON.parse(body) as Record<string, unknown>
      if (req.headers['x-test-redirect'] === 'true') {
        res.writeHead(302, {
          Location: 'https://attacker.invalid/redirected',
          'Set-Cookie': 'upstream-session=secret',
          'X-Upstream-Internal': 'private'
        })
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
      await new Promise<void>((resolve) => {
        releaseUpstream = resolve
      })
      res.write('data: {"choices":[{"delta":{"content":" second"}}]}\n\n')
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(LLAMA_SERVER_PORT, '127.0.0.1', () => resolve())
  })

  gatewayPort = await unusedPort()
  startModelServer(gatewayPort)
  await waitForGateway()
})

afterAll(async () => {
  releaseUpstream?.()
  stopModelServer()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
})

describe('model gateway chat streaming', () => {
  it('reports and activates the Desktop remote Chat model through the management API', async () => {
    const remote = await import('../vision/remote-vision-server')
    const serverId = 'mobile-model-parity'
    const modelId = 'google/gemini-3.7-flash'
    const inventoryId = encodeModelRouteId({
      adapterId: 'desktop.remote-chat',
      providerId: 'custom',
      serverId,
      modelId
    })

    try {
      await remote.setRemoteVisionServerSettings({
        provider: 'custom',
        endpoint: 'https://openrouter.ai/api/v1',
        model: modelId,
        serverId,
        name: 'OpenRouter'
      })

      const activeBefore = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models/active`)
      expect(activeBefore.status).toBe(200)
      expect(await activeBefore.json()).toMatchObject({ text: inventoryId })

      const inventory = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`)
      expect(inventory.status).toBe(200)
      const inventoryBody = (await inventory.json()) as {
        data: Array<Record<string, unknown>>
        models: Array<Record<string, unknown>>
      }
      expect(inventoryBody.data.find((entry) => entry.kind === 'chat')).toMatchObject({
        id: inventoryId,
        name: modelId,
        remote: true,
        capabilities: ['vision', 'tools']
      })
      expect(inventoryBody.models.find((entry) => entry.kind === 'chat')).toMatchObject({
        model: inventoryId
      })

      remote.deactivateRemoteVisionModel()
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: inventoryId, kind: 'text' })
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ success: true })
      expect(remote.getRemoteVisionServerSettings().activeServerId).toBe(serverId)
    } finally {
      remote.removeRemoteVisionServer(serverId)
    }
  })

  it('routes a Mobile remote inventory id through its configured provider', async () => {
    const remote = await import('../vision/remote-vision-server')
    const serverId = 'mobile-gemini-route'
    const modelId = 'google/gemini-3.7-flash'
    let providerBody: Record<string, unknown> | undefined
    let providerAuthorization: string | undefined
    const provider = http.createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: modelId }] }))
        return
      }
      let raw = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => {
        raw += chunk
      })
      request.on('end', () => {
        providerBody = JSON.parse(raw) as Record<string, unknown>
        providerAuthorization = request.headers.authorization
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { content: 'Real Gemini answer' } }] }))
      })
    })
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
    const providerPort = (provider.address() as AddressInfo).port
    const localRequestBefore = upstreamRequest

    try {
      await remote.setRemoteVisionServerSettings({
        provider: 'custom',
        endpoint: `http://127.0.0.1:${providerPort}/v1`,
        model: modelId,
        serverId,
        name: 'Gemini provider',
        apiKey: 'provider-secret'
      })
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: encodeModelRouteId({
            adapterId: 'desktop.remote-chat',
            providerId: 'custom',
            serverId,
            modelId
          }),
          stream: false,
          messages: [{ role: 'user', content: 'Do not echo me' }]
        })
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        choices: [{ message: { content: 'Real Gemini answer' } }]
      })
      expect(providerBody).toMatchObject({
        model: modelId,
        stream: false,
        messages: [{ role: 'user', content: 'Do not echo me' }]
      })
      expect(providerAuthorization).toBe('Bearer provider-secret')
      expect(upstreamRequest).toBe(localRequestBefore)
    } finally {
      remote.removeRemoteVisionServer(serverId)
      await new Promise<void>((resolve) => provider.close(() => resolve()))
    }
  })

  it('rejects malformed input with a stable JSON envelope and remains healthy', async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"messages":['
    })

    expect(response.status).toBe(400)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({
      error: { message: 'Invalid JSON body.', type: 'invalid_request_error' }
    })

    const health = await fetch(`http://127.0.0.1:${gatewayPort}/v1`)
    expect(health.status).toBe(200)
    expect(health.headers.get('content-type')).toContain('application/json')
  })

  it('forwards the real request and streams tokens before llama-server completes', async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'active',
        stream: true,
        messages: [{ role: 'user', content: 'Reply in two chunks' }]
      })
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('x-request-id')).toBeTruthy()

    const reader = response.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('"content":"first"')
    expect(first).not.toContain('[DONE]')
    expect(upstreamRequest).toMatchObject({
      model: 'active',
      stream: true,
      messages: [{ role: 'user', content: 'Reply in two chunks' }]
    })

    releaseUpstream?.()
    let rest = ''
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      rest += new TextDecoder().decode(chunk.value)
    }
    expect(rest).toContain('"content":" second"')
    expect(rest).toContain('data: [DONE]')
  })

  it('does not forward redirects or arbitrary headers from the model process', async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', 'X-Test-Redirect': 'true' },
      body: JSON.stringify({ model: 'active', messages: [{ role: 'user', content: 'redirect' }] })
    })

    expect(response.status).toBe(502)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('x-upstream-internal')).toBeNull()
  })

  it('downloads only the manually chosen model, activates it, and answers (#11)', async () => {
    const previousBinDir = process.env.OFFGRID_BIN_DIR
    process.env.OFFGRID_BIN_DIR = installLlamaBoundary(workingLlamaBoundary('manual model ready'))
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return url.startsWith('http://127.0.0.1:')
        ? hostFetch(input, init)
        : Promise.resolve(fixtureDownload(url))
    })
    const [{ llm }, setup, manager] = await Promise.all([
      import('../llm'),
      import('../setup'),
      import('../models-manager')
    ])
    try {
      await resetNativeJourney(llm)
      const chosen = await setup.getRecommendation('conservative')
      expect(chosen).not.toBeNull()

      expect(await manager.downloadModel(chosen!.id)).toEqual({ success: true })
      expect(await manager.listInstalled()).toEqual([chosen!.id])
      expect(await manager.activateModel(chosen!.id)).toEqual({ success: true })
      await llm.restart()

      expect(await llm.chat('Confirm this manually selected model is usable')).toBe(
        'manual model ready'
      )
      expect(manager.getActiveModel()).toBe(chosen!.id)
    } finally {
      await resetNativeJourney(llm)
      vi.unstubAllGlobals()
      if (previousBinDir === undefined) delete process.env.OFFGRID_BIN_DIR
      else process.env.OFFGRID_BIN_DIR = previousBinDir
    }
  })

  it('configures the recommended local baseline and activates every chosen model (#10)', async () => {
    const previousBinDir = process.env.OFFGRID_BIN_DIR
    process.env.OFFGRID_BIN_DIR = installLlamaBoundary(workingLlamaBoundary())
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return url.startsWith('http://127.0.0.1:')
        ? hostFetch(input, init)
        : Promise.resolve(fixtureDownload(url))
    })

    const [{ llm }, setup, manager] = await Promise.all([
      import('../llm'),
      import('../setup'),
      import('../models-manager')
    ])
    try {
      await resetNativeJourney(llm)
      // Conservative still installs the complete lightweight local baseline while
      // avoiding the heavyweight image-runtime download in this deterministic rig.
      await expect(llm.setSettings({ performanceMode: 'conservative' })).rejects.toThrow(
        'Models not downloaded'
      )
      const plan = await setup.getSetupPlan()
      expect(plan.mode).toBe('conservative')
      expect(plan.items.map((item) => item.kind)).toEqual(['chat', 'transcription', 'voice'])
      expect(await manager.listInstalled()).not.toEqual(
        expect.arrayContaining(plan.items.map((item) => item.id))
      )

      const progress: import('../setup').SetupProgress[] = []
      const result = await setup.autoConfigure((event) => progress.push(event))

      expect(result).toMatchObject({ success: true, modelId: plan.items[0]?.id })
      expect(progress.at(-1)).toMatchObject({ phase: 'done', modelId: plan.items[0]?.id })
      expect(await manager.listInstalled()).toEqual(
        expect.arrayContaining(plan.items.map((item) => item.id))
      )
      expect(manager.getActiveModel()).toBe(plan.items[0]?.id)
      expect(manager.getActiveModalities()).toMatchObject({
        text: plan.items[0]?.id,
        transcription: plan.items.find((item) => item.kind === 'transcription')?.id,
        speech: plan.items.find((item) => item.kind === 'voice')?.id
      })
    } finally {
      await resetNativeJourney(llm)
      vi.unstubAllGlobals()
      if (previousBinDir === undefined) delete process.env.OFFGRID_BIN_DIR
      else process.env.OFFGRID_BIN_DIR = previousBinDir
    }
  })

  it('carries native engine stderr into the actionable System Health result (#14)', async () => {
    const previousBinDir = process.env.OFFGRID_BIN_DIR
    process.env.OFFGRID_BIN_DIR = installLlamaBoundary(
      'process.stderr.write("unknown model architecture: \'gemma4\'\\n"); setTimeout(() => process.exit(23), 20)'
    )
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return url.startsWith('http://127.0.0.1:')
        ? hostFetch(input, init)
        : Promise.resolve(fixtureDownload(url))
    })

    const [{ llm }, setup, manager] = await Promise.all([
      import('../llm'),
      import('../setup'),
      import('../models-manager')
    ])
    try {
      await resetNativeJourney(llm)
      const chosen = await setup.getRecommendation('conservative')
      expect(chosen).not.toBeNull()
      expect(await manager.downloadModel(chosen!.id)).toEqual({ success: true })
      expect(await manager.activateModel(chosen!.id)).toEqual({ success: true })

      await expect(llm.restart()).rejects.toThrow(/did not come back up/i)
      // The crash handler has a delayed retry. Pausing is the real lifecycle intent
      // that prevents that recovery timer from leaking work beyond this journey.
      llm.pause()

      const health = await setup.getSystemHealth()
      const chat = health.components.find((component) => component.id === 'chat')
      expect(chat).toMatchObject({ status: 'down' })
      expect(chat?.detail).toMatch(/engine.*too old/i)
      expect(chat?.detail).toContain('gemma4')
      expect(chat?.detail).not.toBe('Model installed but server is not running')
    } finally {
      await resetNativeJourney(llm)
      vi.unstubAllGlobals()
      if (previousBinDir === undefined) delete process.env.OFFGRID_BIN_DIR
      else process.env.OFFGRID_BIN_DIR = previousBinDir
    }
  })
})
