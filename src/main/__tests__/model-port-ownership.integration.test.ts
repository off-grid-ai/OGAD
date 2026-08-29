/**
 * RELEASE_TEST_CHECKLIST #146 - a held model port never dead-ends the app.
 *
 * The first owner is either the already-running healthy production llama-server or a separate
 * process launching the only fake: a behaviour-faithful native llama-server boundary on the real
 * production port. The contender is the production LLMService, which - rather than refusing when
 * the preferred port is taken - scans upward for a free port and starts its own engine there, so
 * the app works even when something else holds :8439. Real lsof/ps parent ownership, loopback
 * HTTP, GGUF validation, model resolution, free-port fallback, and chat-health presentation
 * remain real. Cleanup only owns processes this test spawned.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseWindowsListenerPids, sysTool } from '../kill-orphan-port'
import { LLAMA_SERVER_PORT } from '../../shared/ports'

const fixture = (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-port-owner-'))
  return {
    root,
    dataDir: path.join(root, 'data'),
    binDir: path.join(root, 'bin'),
    engineLog: path.join(root, 'engine.log')
  }
})()
const previousDataDir = process.env.OFFGRID_DATA_DIR
const previousBinDir = process.env.OFFGRID_BIN_DIR
process.env.OFFGRID_DATA_DIR = fixture.dataDir
process.env.OFFGRID_BIN_DIR = fixture.binDir

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

let liveOwner: ChildProcess | null = null
let enginePid = 0
let expectedModelId: string | null = 'first-owner'

function createValidGguf(filePath: string): void {
  const bytes = Buffer.alloc(2_048)
  bytes.write('GGUF')
  fs.writeFileSync(filePath, bytes)
}

function installNativeBoundary(): string {
  const executable = path.join(fixture.binDir, 'llama', 'llama-server')
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/health') return res.end('{"status":"ok"}')
  if (req.url === '/v1/models') return res.end('{"data":[{"id":"first-owner"}]}')
  res.statusCode = 404
  res.end('{}')
})
server.listen(port, '127.0.0.1', () => {
    const address = server.address()
    const actualPort = typeof address === 'object' && address ? address.port : port
    // Only the test-spawned FIRST owner sets this log; the production LLMService spawning the
    // same binary on its fallback port does NOT, so it must not crash on a missing log path.
    if (process.env.OFFGRID_TEST_ENGINE_LOG) {
      fs.appendFileSync(
        process.env.OFFGRID_TEST_ENGINE_LOG,
        String(process.pid) + ':' + String(actualPort) + '\\n'
      )
    }
})
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`
  )
  fs.chmodSync(executable, 0o755)
  return executable
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  timeout = 5_000
): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function engineIsReady(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(LLAMA_SERVER_PORT)}/v1/models`)
    const body = (await response.json()) as { data?: { id?: string }[] }
    const modelId = body.data?.[0]?.id
    return response.ok && !!modelId && (!expectedModelId || modelId === expectedModelId)
  } catch {
    return false
  }
}

function listenerPids(): number[] {
  try {
    if (process.platform === 'win32') {
      return parseWindowsListenerPids(
        execSync(`"${sysTool('netstat')}" -ano -p tcp`, { encoding: 'utf-8' }),
        LLAMA_SERVER_PORT
      ).map(Number)
    }
    return execSync(`"${sysTool('lsof')}" -ti tcp:${String(LLAMA_SERVER_PORT)}`, {
      encoding: 'utf-8'
    })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
}

function processCommand(pid: number): string {
  try {
    return process.platform === 'win32'
      ? execSync(`"${sysTool('tasklist')}" /FI "PID eq ${String(pid)}" /FO CSV /NH`, {
          encoding: 'utf-8'
        })
      : execSync(`"${sysTool('ps')}" -p ${String(pid)} -o command=`, {
          encoding: 'utf-8'
        }).trim()
  } catch {
    return ''
  }
}

beforeAll(async () => {
  const modelsDir = path.join(fixture.dataDir, 'models')
  fs.mkdirSync(modelsDir, { recursive: true })
  const modelName = 'port-owner-fixture.gguf'
  createValidGguf(path.join(modelsDir, modelName))
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'port-owner-fixture', primary: modelName })
  )
  const executable = installNativeBoundary()

  const listeners = listenerPids()
  if (listeners.length > 0) {
    const llamaOwner = listeners.find((pid) => /llama-server/i.test(processCommand(pid)))
    if (!llamaOwner) {
      throw new Error(
        `Production model port ${String(LLAMA_SERVER_PORT)} is occupied by an unrecognized process.`
      )
    }
    enginePid = llamaOwner
    expectedModelId = null
    await waitFor(engineIsReady, 'existing healthy model engine owner', 5_000)
    return
  }

  const ownerSource = `
const { spawn } = require('node:child_process')
let child
let stopping = false
function startOwner() {
  child = spawn(process.env.OFFGRID_TEST_ENGINE, ['--port', process.env.OFFGRID_TEST_PORT], {
    env: process.env,
    stdio: 'ignore'
  })
  child.on('exit', () => {
    if (stopping) process.exit(0)
    setTimeout(startOwner, 100)
  })
}
process.on('SIGTERM', () => {
  stopping = true
  if (child) child.kill('SIGTERM')
  else process.exit(0)
})
startOwner()
setInterval(() => {}, 1000)
`
  liveOwner = spawn(process.execPath, ['-e', ownerSource], {
    env: {
      ...process.env,
      OFFGRID_TEST_ENGINE: executable,
      OFFGRID_TEST_ENGINE_LOG: fixture.engineLog,
      OFFGRID_TEST_PORT: String(LLAMA_SERVER_PORT)
    },
    stdio: 'ignore'
  })
  await waitFor(
    () =>
      fs.existsSync(fixture.engineLog) && fs.readFileSync(fixture.engineLog, 'utf8').trim() !== '',
    'first model engine address',
    20_000
  )
  const [pidText, portText] = fs.readFileSync(fixture.engineLog, 'utf8').trim().split(':')
  enginePid = Number(pidText)
  expect(Number(portText)).toBe(LLAMA_SERVER_PORT)
  await waitFor(engineIsReady, 'first model engine owner', 20_000)
}, 25_000)

afterAll(async () => {
  if (liveOwner) {
    liveOwner.kill('SIGTERM')
    await waitFor(() => !processIsAlive(enginePid), 'first model engine to exit')
  }
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
  if (previousBinDir === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = previousBinDir
  fs.rmSync(fixture.root, { recursive: true, force: true })
})

describe('model port ownership', () => {
  it('preserves the first live engine and falls back to a free port for the second (#146)', async () => {
    const [{ llm }, { getSystemHealth }, { modelPortConflictReason }] = await Promise.all([
      import('../llm'),
      import('../setup'),
      import('../llama-error')
    ])
    const conflict = modelPortConflictReason(LLAMA_SERVER_PORT)
    const lifecycle: Array<{ ready: boolean; starting: boolean }> = []
    const offHealth = llm.onHealthInvalidated(() =>
      lifecycle.push({ ready: llm.isReady(), starting: llm.isStarting() })
    )

    // The preferred port is held by the first live engine. Rather than dead-ending on a
    // single-owner conflict, the second instance scans upward and starts its own engine on a
    // free port — the app just works even when something else holds :8439.
    await llm.init()
    expect(llm.isReady()).toBe(true)
    expect(llm.getPort()).not.toBe(LLAMA_SERVER_PORT)
    // The conflict reason is NOT surfaced — we moved instead of refusing.
    expect(llm.lastError()).not.toBe(conflict)
    expect(lifecycle).toContainEqual({ ready: false, starting: true })
    expect(lifecycle).toContainEqual({ ready: true, starting: false })

    // The FIRST engine is untouched: still alive, still the sole owner of the preferred port.
    expect(processIsAlive(enginePid)).toBe(true)
    expect(await engineIsReady()).toBe(true)
    if (liveOwner) {
      expect(fs.readFileSync(fixture.engineLog, 'utf8').trim().split(/\r?\n/)).toEqual([
        `${String(enginePid)}:${String(LLAMA_SERVER_PORT)}`
      ])
    }

    // Chat health reports UP, on the fallback port — not down with a port-conflict detail.
    const chatHealth = (await getSystemHealth()).components.find(
      (component) => component.id === 'chat'
    )
    expect(chatHealth).toMatchObject({ status: 'ready', port: llm.getPort() })
    expect(chatHealth?.detail).not.toBe(conflict)

    // Tear down the second engine this test started (the first owner is cleaned up in afterAll).
    await llm.unload()
    expect(lifecycle.at(-1)).toEqual({ ready: false, starting: false })
    offHealth()
  })
})
