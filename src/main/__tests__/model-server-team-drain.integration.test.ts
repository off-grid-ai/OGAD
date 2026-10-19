/**
 * Switching the gateway's mode relaunches llama-server. In Team mode the relaunch waits for the
 * streams in flight to finish instead of cutting them. The native llama-server is a small script
 * at its executable boundary that logs each launch's argv and holds a stream until the test lets
 * it end; the gateway, the engine's lifecycle and the limiters are the production code.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-gateway-team-drain-'))
const BIN_DIR = path.join(PROFILE_DIR, 'bin')
const LAUNCH_LOG = path.join(PROFILE_DIR, 'launches.log')
const previousDataDir = process.env.OFFGRID_DATA_DIR
const previousBinDir = process.env.OFFGRID_BIN_DIR

vi.mock('electron', () => ({
  app: {
    getPath: () => PROFILE_DIR,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.40'
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

/** llama-server: logs its --parallel at launch; a prompt saying "hold" streams until POST /release. */
function installEngine(): void {
  const executable = path.join(BIN_DIR, 'llama', 'llama-server')
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const args = process.argv.slice(2)
const valueAfter = (flag) => args[args.indexOf(flag) + 1]
// A device probe (the app asks which GPUs the engine sees on Linux and Windows) is not a launch.
if (args.includes('--list-devices')) {
  console.log('Available devices:')
  process.exit(0)
}
fs.appendFileSync(${JSON.stringify(LAUNCH_LOG)}, 'launch ' + valueAfter('--parallel') + '\\n')
const held = []
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200); res.end('{"status":"ok"}'); return }
  if (req.method === 'GET' && req.url === '/props') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ modalities: { vision: false }, chat_template_caps: {}, chat_template: '' }))
    return
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'drain-model.gguf' }] }))
    return
  }
  if (req.method === 'POST' && req.url === '/release') {
    for (const finish of held.splice(0)) finish()
    res.end('ok')
    return
  }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return }
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const frame = (content) => 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\\n\\n'
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(frame('first'))
    const finish = () => res.end(frame(' done') + 'data: [DONE]\\n\\n')
    if (body.includes('hold')) {
      held.push(finish)
      fs.appendFileSync(${JSON.stringify(LAUNCH_LOG)}, 'held\\n')
    } else finish()
  })
})
server.listen(Number(valueAfter('--port')), '127.0.0.1')
const stop = () => server.close(() => process.exit(0))
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
`
  )
  fs.chmodSync(executable, 0o755)
}

function log(): string[] {
  return fs.existsSync(LAUNCH_LOG) ? fs.readFileSync(LAUNCH_LOG, 'utf8').trim().split('\n') : []
}

async function waitFor(check: () => boolean, what: string, ms = 10_000): Promise<void> {
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

let llm: typeof import('../llm').llm
let gateway: typeof import('../model-server')
let gatewayPort: number

beforeAll(async () => {
  process.env.OFFGRID_DATA_DIR = PROFILE_DIR
  process.env.OFFGRID_BIN_DIR = BIN_DIR
  installEngine()
  const manager = await import('../models-manager')
  ;({ llm } = await import('../llm'))
  gateway = await import('../model-server')
  ;(llm as unknown as { port: number }).port = await unusedPort()
  const fixture = path.join(PROFILE_DIR, 'drain-model.gguf')
  const bytes = Buffer.alloc(2048, 7)
  bytes.write('GGUF')
  fs.writeFileSync(fixture, bytes)
  const model = await manager.importLocalModel(fixture)
  expect(await manager.setActiveModel(model.id!)).toEqual({ success: true })
  await llm.setSettings({ gatewayMode: 'team' })
  await llm.restart()
  gatewayPort = await unusedPort()
  await gateway.startModelServer(gatewayPort)
}, 60_000)

afterAll(() => {
  gateway.stopModelServer()
  llm.stop()
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
  if (previousBinDir === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = previousBinDir
})

describe('a mode change in Team mode', () => {
  it('relaunches the engine only after the stream in flight has finished', async () => {
    expect(log().filter((line) => line.startsWith('launch'))).toHaveLength(1)
    expect(log()[0]).not.toBe('launch 1')
    const reply = fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hold this' }] })
    }).then((response) => response.text())
    await waitFor(() => log().includes('held'), 'the stream to start')

    const switched = llm.setSettings({ gatewayMode: 'single' })
    await new Promise((resolve) => setTimeout(resolve, 400))
    // Still the first engine: the relaunch waits for the stream.
    expect(log().filter((line) => line.startsWith('launch'))).toHaveLength(1)

    await fetch(`http://127.0.0.1:${llm.getPort()}/release`, { method: 'POST' })
    // The stream finished whole, then the engine came back with one slot.
    expect(await reply).toContain('done')
    await switched
    expect(log().filter((line) => line.startsWith('launch'))).toEqual([log()[0], 'launch 1'])
  })
})
