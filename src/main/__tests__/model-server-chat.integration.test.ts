/**
 * Real HTTP integration for the local OpenAI-compatible gateway chat seam.
 *
 * Chat is served by the shared GenerationService (the same path as Desktop's own chat), so the
 * only fake is the native llama-server executable: a loopback HTTP server speaking its real SSE
 * protocol on the port the engine is told to bind. The gateway must stream the first token before
 * the engine completes, return the model's tool calls to the client unexecuted, and answer every
 * failure with the stable JSON envelope.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'
import { CATALOG, WHISPER_MIN_BYTES, encodeModelRouteId } from '@offgrid/models'

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

let gatewayPort: number
const UPSTREAM_REQUEST_FILE = path.join(TMP_DIR, 'upstream-request.json')
const UPSTREAM_RELEASE_FILE = path.join(TMP_DIR, 'upstream-release')
let startModelServer: typeof import('../model-server').startModelServer
let stopModelServer: typeof import('../model-server').stopModelServer
const previousDataDir = process.env.OFFGRID_DATA_DIR
const restoreCatalogFacts: Array<() => void> = []

function installLlamaBoundary(source: string): string {
  const binRoot = path.join(TMP_DIR, 'test-bin')
  const executable = path.join(binRoot, 'llama', 'llama-server')
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(executable, `#!/usr/bin/env node\n${source}\n`)
  fs.chmodSync(executable, 0o755)
  return binRoot
}

/** A llama-server that records each chat request, streams a first token, then holds the second
 * until the test releases it; answers tool requests with a tool call; answers "redirect" turns
 * with a 302 carrying headers the gateway must never forward. */
function gatewayLlamaBoundary(): string {
  return `
const http = require('node:http')
const fs = require('node:fs')
const portArg = process.argv.indexOf('--port')
const port = Number(process.argv[portArg + 1])
const REQUEST_FILE = ${JSON.stringify(UPSTREAM_REQUEST_FILE)}
const RELEASE_FILE = ${JSON.stringify(UPSTREAM_RELEASE_FILE)}
const frame = (payload) => 'data: ' + JSON.stringify(payload) + '\\n\\n'
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
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      fs.writeFileSync(REQUEST_FILE, body)
      const parsed = JSON.parse(body)
      if (JSON.stringify(parsed.messages).includes('redirect')) {
        response.writeHead(302, {
          Location: 'https://attacker.invalid/redirected',
          'Set-Cookie': 'upstream-session=secret',
          'X-Upstream-Internal': 'private'
        })
        response.end()
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (Array.isArray(parsed.tools) && parsed.tools.length) {
        response.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '' } }] } }] }))
        response.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":"off grid"}' } }] } }] }))
        response.write(frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }))
        response.end('data: [DONE]\\n\\n')
        return
      }
      response.write(frame({ choices: [{ delta: { content: 'first' } }] }))
      const finish = () => {
        if (!fs.existsSync(RELEASE_FILE)) return setTimeout(finish, 10)
        response.write(frame({ choices: [{ delta: { content: ' second' }, finish_reason: 'stop' }] }))
        response.end('data: [DONE]\\n\\n')
      }
      finish()
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

function recordedUpstreamRequest(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(UPSTREAM_REQUEST_FILE, 'utf8')) as Record<string, unknown>
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
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      if (JSON.parse(body).stream === true) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: ${JSON.stringify(reply)} }, finish_reason: 'stop' }] }) + '\\n\\ndata: [DONE]\\n\\n')
        return
      }
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
  const name = decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? '')
  const bytes = Buffer.alloc(/^ggml-[^/\\]+\.bin$/i.test(name) ? WHISPER_MIN_BYTES : 2048, 7)
  if (/\.gguf(?:\?|$)/i.test(url)) bytes.write('GGUF')
  if (/\.zip(?:\?|$)/i.test(url)) bytes.write('PK\x03\x04')
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
  for (const model of CATALOG) {
    for (const file of model.files) {
      const mutable = file as { sizeBytes?: number; sha256?: string }
      const originalSize = mutable.sizeBytes
      const originalSha256 = mutable.sha256
      mutable.sizeBytes = /^ggml-[^/\\]+\.bin$/i.test(file.name) ? WHISPER_MIN_BYTES : 2048
      mutable.sha256 = undefined
      restoreCatalogFacts.push(() => {
        mutable.sizeBytes = originalSize
        mutable.sha256 = originalSha256
      })
    }
  }
  ;({ startModelServer, stopModelServer } = await import('../model-server'))
  gatewayPort = await unusedPort()
  startModelServer(gatewayPort)
  await waitForGateway()
})

afterAll(async () => {
  for (const restore of restoreCatalogFacts.splice(0)) restore()
  stopModelServer()
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
})

describe('model gateway chat streaming', () => {
  it('publishes authoritative catalog capability evidence without changing it', async () => {
    const model = CATALOG[0]
    if (!model) throw new Error('catalog fixture is empty')
    const original = model.capabilities
    model.capabilities = {
      ...original,
      vision: true,
      tools: false,
      thinking: true
    }
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models/catalog`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as { models: Array<Record<string, unknown>> }
      expect(body.models.find((entry) => entry.id === model.id)).toMatchObject({
        capabilities: {
          vision: true,
          tools: false,
          thinking: true
        }
      })
    } finally {
      model.capabilities = original
    }
  })

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

      // Clearing the text selection goes through the one selection owner; nothing in the remote
      // module decides selection any more.
      await (await import('../model-services')).desktopModelServices.workspace.select('text', null)
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: inventoryId, kind: 'text' })
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ success: true })
      expect(remote.getRemoteVisionServerSettings().activeServerId).toBe(serverId)
    } finally {
      await remote.removeRemoteVisionServer(serverId)
    }
  })

  it('routes a Mobile remote inventory id through its configured local provider', async () => {
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
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'Real Gemini answer' }, finish_reason: 'stop' }] })}\n\n`
        )
        response.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
    const providerPort = (provider.address() as AddressInfo).port

    try {
      await remote.setRemoteVisionServerSettings({
        provider: 'custom',
        endpoint: `http://127.0.0.1:${providerPort}/v1`,
        model: modelId,
        serverId,
        name: 'Gemini provider'
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
      // The shared remote transport always streams from the provider; the client asked for a
      // complete answer, so the gateway assembled it.
      expect(providerBody).toMatchObject({
        model: modelId,
        stream: true,
        messages: [{ role: 'user', content: 'Do not echo me' }]
      })
      expect(providerAuthorization).toBeUndefined()
      expect(fs.existsSync(UPSTREAM_REQUEST_FILE)).toBe(false)
    } finally {
      await remote.removeRemoteVisionServer(serverId)
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

  it('answers 503 in the JSON envelope when no text model is selected', async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'active', messages: [{ role: 'user', content: 'anyone there?' }] })
    })

    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toMatchObject({
      error: { type: 'unavailable_error', message: expect.stringMatching(/no compatible text model/i) }
    })
  })

  describe('served by the shared generation service', () => {
    const previousBinDir = process.env.OFFGRID_BIN_DIR
    let llm: typeof import('../llm').llm

    beforeAll(async () => {
      process.env.OFFGRID_BIN_DIR = installLlamaBoundary(gatewayLlamaBoundary())
      vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        return url.startsWith('http://127.0.0.1:')
          ? hostFetch(input, init)
          : Promise.resolve(fixtureDownload(url))
      })
      const [llmModule, setup, manager] = await Promise.all([
        import('../llm'),
        import('../setup'),
        import('../models-manager')
      ])
      llm = llmModule.llm
      await resetNativeJourney(llm)
      const chosen = await setup.getRecommendation('conservative')
      if (!chosen) throw new Error('no recommended chat model')
      expect(await manager.downloadModel(chosen.id)).toEqual({ success: true })
      expect(await manager.activateModel(chosen.id)).toEqual({ success: true })
    })

    afterAll(async () => {
      await resetNativeJourney(llm)
      vi.unstubAllGlobals()
      if (previousBinDir === undefined) delete process.env.OFFGRID_BIN_DIR
      else process.env.OFFGRID_BIN_DIR = previousBinDir
    })

    afterEach(() => {
      fs.rmSync(UPSTREAM_RELEASE_FILE, { force: true })
      fs.rmSync(UPSTREAM_REQUEST_FILE, { force: true })
    })

    it('streams tokens in OpenAI frames before the engine completes', async () => {
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
      expect(first).toContain('"object":"chat.completion.chunk"')
      expect(first).not.toContain('[DONE]')
      // The engine received the shared local completion payload (the Mac's alias names the
      // model, not the client's string), carrying the user's turn and streaming.
      const upstreamRequest = recordedUpstreamRequest()
      expect(upstreamRequest.stream).toBe(true)
      expect(JSON.stringify(upstreamRequest.messages)).toContain('Reply in two chunks')

      fs.writeFileSync(UPSTREAM_RELEASE_FILE, '')
      let rest = ''
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        rest += new TextDecoder().decode(chunk.value)
      }
      expect(rest).toContain('"content":" second"')
      expect(rest).toContain('"finish_reason":"stop"')
      expect(rest).toContain('data: [DONE]')
    })

    it('returns the model\'s tool calls to the client and does not execute them', async () => {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'active',
          stream: true,
          messages: [{ role: 'user', content: 'search for off grid' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'web_search',
                description: 'Search the web',
                parameters: { type: 'object', properties: { query: { type: 'string' } } }
              }
            }
          ]
        })
      })

      expect(response.status).toBe(200)
      const frames = (await response.text())
        .split('\n\n')
        .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
        .map((line) => JSON.parse(line.slice('data: '.length)) as {
          choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>
        })
      const toolDeltas = frames.flatMap((frame) =>
        (frame.choices[0]?.delta.tool_calls as Array<Record<string, unknown>> | undefined) ?? []
      )
      expect(toolDeltas.length).toBeGreaterThan(0)
      expect(JSON.stringify(toolDeltas)).toContain('web_search')
      expect(JSON.stringify(toolDeltas)).toContain('off grid')
      expect(frames.at(-1)?.choices[0]?.finish_reason).toBe('tool_calls')
      // Exactly one engine round: the gateway never ran the tool and fed a result back.
      expect(JSON.stringify(recordedUpstreamRequest().messages)).not.toContain('"role":"tool"')
    })

    it('does not forward redirects or arbitrary headers from the model process', async () => {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'active', messages: [{ role: 'user', content: 'redirect' }] })
      })

      expect(response.status).toBe(502)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(response.headers.get('location')).toBeNull()
      expect(response.headers.get('set-cookie')).toBeNull()
      expect(response.headers.get('x-upstream-internal')).toBeNull()
      expect(await response.json()).toMatchObject({ error: { type: 'upstream_error' } })
    })
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
      const installedBeforeChoice = new Set(await manager.listInstalled())

      expect(await manager.downloadModel(chosen!.id)).toEqual({ success: true })
      const manuallyAdded = (await manager.listInstalled()).filter(
        (modelId) => !installedBeforeChoice.has(modelId)
      )
      // Runtime-managed models such as ExecuTorch Kokoro are already available
      // without this download. The only model added by this user action is the
      // selected Chat model.
      expect(manuallyAdded).toEqual([chosen!.id])
      expect(await manager.activateModel(chosen!.id)).toEqual({ success: true })
      await llm.restart()

      expect(
        (
          await llm.streamChatLocal(
            [{ role: 'user', content: 'Confirm this manually selected model is usable' }],
            () => {}
          )
        ).content
      ).toBe('manual model ready')
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
