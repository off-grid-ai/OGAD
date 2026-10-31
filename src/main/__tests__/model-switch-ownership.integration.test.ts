/**
 * A model selection made during a live turn must not kill that turn. The native
 * llama-server is controlled at its executable boundary; model import, activation,
 * process ownership, SSE transport, and handoff are the production implementations.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-model-handoff-'))
const BIN_DIR = path.join(PROFILE_DIR, 'bin')
const FIXTURE_DIR = path.join(PROFILE_DIR, 'fixtures')
const previousDataDir = process.env.OFFGRID_DATA_DIR
const previousBinDir = process.env.OFFGRID_BIN_DIR

vi.mock('electron', () => ({
  app: {
    getPath: () => PROFILE_DIR,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.40'
  }
}))

function writeGguf(name: string): string {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true })
  const fixture = path.join(FIXTURE_DIR, name)
  const bytes = Buffer.alloc(2048, 7)
  bytes.write('GGUF')
  fs.writeFileSync(fixture, bytes)
  return fixture
}

function installModelAwareEngine(): void {
  const executable = path.join(BIN_DIR, 'llama', 'llama-server')
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env node
const http = require('node:http')
const path = require('node:path')
const args = process.argv.slice(2)
const valueAfter = (flag) => args[args.indexOf(flag) + 1]
const port = Number(valueAfter('--port'))
const model = path.basename(valueAfter('-m'))
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"status":"ok"}')
    return
  }
  if (req.method === 'GET' && req.url === '/props') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      modalities: { vision: false },
      chat_template_caps: { supports_tools: true },
      chat_template: '{% if enable_thinking %}<think>{% endif %}'
    }))
    return
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: model }] }))
    return
  }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404)
    res.end()
    return
  }
  let body = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    const payload = JSON.parse(body)
    const prompt = JSON.stringify(payload.messages)
    const frame = (content) => 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\\n\\n'
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(frame(model + ':first'))
    const finish = () => {
      res.write(frame(' second'))
      res.end('data: [DONE]\\n\\n')
    }
    if (prompt.includes('hold this turn')) setTimeout(finish, 300)
    else finish()
  })
})
server.listen(port, '127.0.0.1')
const stop = () => server.close(() => process.exit(0))
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
`
  )
  fs.chmodSync(executable, 0o755)
}

async function unusedPort(): Promise<number> {
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

async function startGateway(server: typeof import('../model-server'), port: number): Promise<void> {
  server.startModelServer(port)
  const deadline = Date.now() + 2_000
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/v1`)).ok) return
    } catch (error) {
      if (Date.now() > deadline) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeAll(() => {
  process.env.OFFGRID_DATA_DIR = PROFILE_DIR
  process.env.OFFGRID_BIN_DIR = BIN_DIR
  installModelAwareEngine()
})

afterAll(() => {
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
  if (previousBinDir === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = previousBinDir
})

describe('active chat model handoff', () => {
  it('finishes the admitted turn on its original model and uses the new model next', async () => {
    const [{ llm }, manager] = await Promise.all([import('../llm'), import('../models-manager')])
    const service = llm as unknown as { port: number }
    service.port = await unusedPort()

    const modelA = await manager.importLocalModel(writeGguf('model-a.gguf'))
    const modelB = await manager.importLocalModel(writeGguf('model-b.gguf'))
    expect(modelA).toMatchObject({ success: true, id: 'local:model-a.gguf' })
    expect(modelB).toMatchObject({ success: true, id: 'local:model-b.gguf' })
    expect(await manager.setActiveModel(modelA.id!)).toEqual({ success: true })

    try {
      await llm.restart()
      const firstDeltas: string[] = []
      let firstToken!: () => void
      const sawFirstToken = new Promise<void>((resolve) => {
        firstToken = resolve
      })
      const firstTurn = llm.chatStream('hold this turn', [], (text) => {
        firstDeltas.push(text)
        if (firstDeltas.length === 1) firstToken()
      })

      await sawFirstToken
      expect(await manager.setActiveModel(modelB.id!)).toEqual({ success: true })

      await expect(firstTurn).resolves.toMatchObject({ content: 'model-a.gguf:first second' })
      expect(firstDeltas.join('')).toBe('model-a.gguf:first second')

      const secondDeltas: string[] = []
      await expect(
        llm.chatStream('next turn', [], (text) => secondDeltas.push(text))
      ).resolves.toMatchObject({ content: 'model-b.gguf:first second' })
      expect(secondDeltas.join('')).toBe('model-b.gguf:first second')
      expect(manager.getActiveModel()).toBe(modelB.id)
    } finally {
      llm.stop()
    }
  })
})

describe('gateway model choice', () => {
  it('makes a requested installed chat model the local model, keeps the remote choice, and lists only live capabilities', async () => {
    const [{ llm }, manager, remote, server] = await Promise.all([
      import('../llm'),
      import('../models-manager'),
      import('../vision/remote-vision-server'),
      import('../model-server')
    ])
    const service = llm as unknown as { port: number }
    service.port = await unusedPort()
    const gatewayPort = await unusedPort()
    const saved = await manager.importLocalModel(writeGguf('gateway-saved.gguf'))
    const other = await manager.importLocalModel(writeGguf('gateway-other.gguf'))
    expect(await manager.setActiveModel(saved.id!)).toEqual({ success: true })
    const serverId = 'gateway-remote-text'
    remote.setRemoteVisionServerSettings({
      provider: 'custom',
      endpoint: 'http://127.0.0.1:9/v1',
      model: 'remote-text',
      serverId,
      name: 'Remote text'
    })
    expect(remote.getActiveRemoteVisionServer()?.id).toBe(serverId)

    await startGateway(server, gatewayPort)
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: other.id,
          stream: true,
          messages: [{ role: 'user', content: 'hi' }]
        })
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('gateway-other.gguf:first')
      const activeFile = JSON.parse(
        fs.readFileSync(path.join(llm.getModelsDir(), 'active-model.json'), 'utf8')
      ) as { id: string }
      expect(activeFile.id).toBe(other.id)
      expect(manager.getActiveModel()).toBe(other.id)
      // A request from another device leaves the person's remote chat choice where it was.
      expect(remote.getActiveRemoteVisionServer()?.id).toBe(serverId)
      const withRemote = (await (
        await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`)
      ).json()) as { data: Record<string, unknown>[] }
      expect(withRemote.data[0]).toMatchObject({ remote: true })
      expect(withRemote.data.find((entry) => entry.id === other.id)).toMatchObject({
        context_length: llm.engineContextWindow()
      })

      // Once the person moves chat back to this Mac, the loaded model leads with its live facts.
      remote.deactivateRemoteVisionModel()
      const listed = (await (await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`)).json()) as {
        data: Record<string, unknown>[]
      }
      expect(listed.data[0]).toMatchObject({
        id: other.id,
        active: true,
        capabilities: ['tools', 'reasoning'],
        context_length: llm.engineContextWindow()
      })
      const savedEntry = listed.data.find((entry) => entry.id === saved.id)
      expect(savedEntry).toMatchObject({ context_length: llm.engineContextWindow() })
      expect(savedEntry).not.toHaveProperty('capabilities')
      expect(savedEntry).not.toHaveProperty('active')
    } finally {
      server.stopModelServer()
      remote.removeRemoteVisionServer(serverId)
      llm.stop()
    }
  })

  it('makes a requested installed image model the active image model', async () => {
    const [{ llm }, manager, server] = await Promise.all([
      import('../llm'),
      import('../models-manager'),
      import('../model-server')
    ])
    const gatewayPort = await unusedPort()
    fs.mkdirSync(llm.getModelsDir(), { recursive: true })
    for (const name of ['gateway-alpha.safetensors', 'gateway-beta.safetensors'])
      fs.writeFileSync(path.join(llm.getModelsDir(), name), Buffer.alloc(2048, 7))
    expect(await manager.setActiveModalChoice('image', 'gateway-alpha.safetensors')).toEqual({
      success: true
    })

    await startGateway(server, gatewayPort)
    try {
      await fetch(`http://127.0.0.1:${gatewayPort}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gateway-beta.safetensors', prompt: 'a lighthouse' })
      })
      expect(manager.getActiveModalities().image).toBe('gateway-beta.safetensors')
    } finally {
      server.stopModelServer()
    }
  })

  // Switching needs two installed models of one kind. Voice has one catalog model since Piper left
  // the catalog (it never had a runtime), so speech has no second model to switch to; transcription
  // runs the same gateway selection (selectRequestedModal) with two real catalog models.
  it.each([{ modality: 'transcription' as const, kind: 'transcription' }])(
    'makes a requested installed $modality model the active $modality model',
    async ({ modality, kind }) => {
      const [{ llm }, manager, server] = await Promise.all([
        import('../llm'),
        import('../models-manager'),
        import('../model-server')
      ])
      const gatewayPort = await unusedPort()
      const candidates = (await manager.desktopCatalog()).filter(
        (model) => model.kind === kind && model.files.length > 0
      )
      const [first, second] = candidates
      expect(second).toBeDefined()
      for (const file of [...first!.files, ...second!.files]) {
        const target = path.join(llm.getModelsDir(), file.name)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, Buffer.alloc(2048, 7))
      }
      expect(await manager.listInstalled()).toEqual(expect.arrayContaining([first!.id, second!.id]))
      expect(await manager.setActiveModalChoice(modality, first!.id)).toEqual({ success: true })

      await startGateway(server, gatewayPort)
      try {
        const form = new FormData()
        form.append('model', second!.id)
        form.append('file', new Blob([Buffer.alloc(64, 1)], { type: 'audio/wav' }), 'clip.wav')
        const accepted = await fetch(
          `http://127.0.0.1:${gatewayPort}/v1/audio/transcriptions?async=true`,
          { method: 'POST', body: form }
        )
        expect(accepted.status).toBe(202)
        expect(manager.getActiveModalities()[modality]).toBe(second!.id)
        const { request_id: requestId } = (await accepted.json()) as { request_id: string }
        await vi.waitFor(
          async () => {
            const job = (await (
              await fetch(`http://127.0.0.1:${gatewayPort}/v1/requests/${requestId}`)
            ).json()) as { status: string }
            expect(['completed', 'failed']).toContain(job.status)
          },
          { timeout: 12_000, interval: 50 }
        )
      } finally {
        server.stopModelServer()
      }
    }
  )
})
