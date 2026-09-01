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
      const firstTurn = llm.streamChatLocal(
        [{ role: 'user', content: 'hold this turn' }],
        (text) => {
          firstDeltas.push(text)
          if (firstDeltas.length === 1) firstToken()
        }
      )

      await sawFirstToken
      expect(await manager.setActiveModel(modelB.id!)).toEqual({ success: true })

      await expect(firstTurn).resolves.toMatchObject({ content: 'model-a.gguf:first second' })
      expect(firstDeltas.join('')).toBe('model-a.gguf:first second')

      const secondDeltas: string[] = []
      await expect(
        llm.streamChatLocal([{ role: 'user', content: 'next turn' }], (text) =>
          secondDeltas.push(text)
        )
      ).resolves.toMatchObject({ content: 'model-b.gguf:first second' })
      expect(secondDeltas.join('')).toBe('model-b.gguf:first second')
      expect(manager.getActiveModel()).toBe(modelB.id)
    } finally {
      llm.stop()
    }
  })
})
