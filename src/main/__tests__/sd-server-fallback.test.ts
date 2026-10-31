/**
 * The resident image server walks the engine ladder when an engine cannot start. The sd-server
 * executables are the only fake: real processes installed under OFFGRID_BIN_DIR that the real
 * ladder finds, the real SdServerService spawns, probes over HTTP and tears down.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { processAlive } from './harness/fake-llama-engine'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-sd-fallback-'))
const BIN = path.join(ROOT, 'bin')
const MODEL = path.join(ROOT, 'model.gguf')
const previous = { data: process.env.OFFGRID_DATA_DIR, bin: process.env.OFFGRID_BIN_DIR }

// An sd-server: `<folder>.fail` beside the engines makes that engine die at start with a load
// error on stderr; `hold` keeps it loading. Each start is logged as `<folder> <pid>`.
const SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const root = path.dirname(__dirname)
const folder = path.basename(__dirname)
const args = process.argv.slice(2)
fs.appendFileSync(path.join(root, 'launches.log'), folder + ' ' + process.pid + '\\n')
if (fs.existsSync(path.join(root, folder + '.fail'))) {
  process.stderr.write(folder + ': ggml backend failed to initialize\\n')
  process.exit(1)
}
const server = http.createServer((req, res) => {
  const loading = fs.existsSync(path.join(root, 'hold'))
  res.writeHead(loading ? 503 : 200, { 'Content-Type': 'application/json' })
  res.end(loading ? '{"error":"loading"}' : '{"modes":["img_gen"]}')
})
server.listen(Number(args[args.indexOf('--listen-port') + 1]), '127.0.0.1')
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`

function launches(): { folder: string; pid: number }[] {
  try {
    return fs
      .readFileSync(path.join(BIN, 'launches.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => ({ folder: line.split(' ')[0]!, pid: Number(line.split(' ')[1]) }))
  } catch {
    return []
  }
}

const fail = (folder: string): void => fs.writeFileSync(path.join(BIN, `${folder}.fail`), '')

let sdServer: (typeof import('../sd-server'))['sdServer']

beforeAll(async () => {
  process.env.OFFGRID_DATA_DIR = ROOT
  process.env.OFFGRID_BIN_DIR = BIN
  fs.writeFileSync(MODEL, Buffer.alloc(1024))
  ;({ sdServer } = await import('../sd-server'))
})

beforeEach(() => {
  fs.rmSync(BIN, { recursive: true, force: true })
  for (const folder of ['sd', 'sd-cpu']) {
    const executable = path.join(BIN, folder, 'sd-server')
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.writeFileSync(executable, SCRIPT, { mode: 0o755 })
  }
})

afterEach(() => {
  sdServer.stop()
  for (const { pid } of launches()) if (processAlive(pid)) process.kill(pid, 'SIGKILL')
})

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
  if (previous.data === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previous.data
  if (previous.bin === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = previous.bin
})

describe('resident image runtime fallback', () => {
  it('starts the next engine when the first cannot load and reports the selected binary', async () => {
    fail('sd')
    await sdServer.ensureUp({ modelPath: MODEL })
    expect(launches().map((launch) => launch.folder)).toEqual(['sd', 'sd-cpu'])
    expect(sdServer.getBinaryPath()).toBe(path.join(BIN, 'sd-cpu', 'sd-server'))
    expect(sdServer.isUp()).toBe(true)
  })

  it('does not start a fallback after the user stops startup', async () => {
    fs.writeFileSync(path.join(BIN, 'hold'), '')
    const starting = sdServer.ensureUp({ modelPath: MODEL })
    const rejected = expect(starting).rejects.toThrow()
    await vi.waitFor(() => expect(launches()).toHaveLength(1))
    sdServer.stop()
    await rejected
    expect(launches().map((launch) => launch.folder)).toEqual(['sd'])
    expect(sdServer.isUp()).toBe(false)
  })

  it('keeps the loaded server for the same model and clears it after a crash', async () => {
    await sdServer.ensureUp({ modelPath: MODEL })
    await sdServer.ensureUp({ modelPath: MODEL })
    expect(launches()).toHaveLength(1)
    expect(sdServer.getBinaryPath()).toBe(path.join(BIN, 'sd', 'sd-server'))

    process.kill(launches()[0]!.pid, 'SIGKILL')
    await vi.waitFor(() => expect(sdServer.isUp()).toBe(false))
    expect(sdServer.getBinaryPath()).toBeNull()
  })

  it('reports failure when every image runtime fails to start', async () => {
    fail('sd')
    fail('sd-cpu')
    await expect(sdServer.ensureUp({ modelPath: MODEL })).rejects.toThrow(
      'sd-cpu: ggml backend failed to initialize'
    )
    expect(launches().map((launch) => launch.folder)).toEqual(['sd', 'sd-cpu'])
    expect(sdServer.getBinaryPath()).toBeNull()
  })
})
