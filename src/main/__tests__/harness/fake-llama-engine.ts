// A behaviour-faithful llama-server EXECUTABLE for tests that start the real engine owners
// (LLMService, the decision runtime). It is installed under an OFFGRID_BIN_DIR, spawned by the
// product's own launch code, and speaks the endpoints those owners probe. Everything above the
// process boundary is our real code.
//
// The test steers it through files beside the binary, the way a real engine is steered by its
// model: `hold` keeps /health at 503 "Loading model" (a slow load), `<folder>.oom` makes that engine
// fail its load the way llama.cpp does when memory runs out, `reply.json` is the body of every
// POST, and `launches.log` records every start as `<engine folder> <pid> <args>`.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

const SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const args = process.argv.slice(2)
const valueAfter = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
const root = path.dirname(__dirname)
const folder = path.basename(__dirname)
const model = path.basename(valueAfter('-m') || 'model.gguf')
fs.appendFileSync(path.join(root, 'launches.log'), folder + ' ' + process.pid + ' ' + args.join(' ') + '\\n')
const oom = path.join(root, folder + '.oom')
if (fs.existsSync(oom) && args.join(' ').includes(fs.readFileSync(oom, 'utf8'))) {
  process.stderr.write('ggml_backend_cuda_buffer_type_alloc_buffer: allocating 4096.00 MiB on device 0: cudaMalloc failed: out of memory\\n')
  process.exit(1)
}
const held = () => fs.existsSync(path.join(root, 'hold'))
// llama-server prints while it loads; the owner treats a silent engine as stalled.
const progress = setInterval(() => process.stderr.write('.'), 100)
const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
const server = http.createServer((req, res) => {
  if (req.url === '/health') return held() ? json(res, 503, { error: { message: 'Loading model' } }) : json(res, 200, { status: 'ok' })
  if (held()) return json(res, 503, { error: { message: 'Loading model' } })
  if (req.url === '/props') return json(res, 200, { modalities: { vision: false }, chat_template_caps: { supports_tools: true } })
  if (req.url === '/v1/models') return json(res, 200, { data: [{ id: model }] })
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    fs.appendFileSync(path.join(root, 'requests.log'), req.method + ' ' + req.url + ' ' + body.replace(/\\n/g, ' ') + '\\n')
    const reply = path.join(root, 'reply.json')
    if (fs.existsSync(reply)) return json(res, 200, JSON.parse(fs.readFileSync(reply, 'utf8')))
    json(res, 200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] })
  })
})
server.listen(Number(valueAfter('--port')), '127.0.0.1')
const stop = () => {
  clearInterval(progress)
  server.close(() => process.exit(0))
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
`

export interface FakeLlamaEngine {
  binDir: string
  /** Keep the engine loading (503) until release(). */
  hold(): void
  release(): void
  /** Make the engine in `folder` run out of memory while loading; with `whenArgsInclude`, only
   *  the launches whose arguments contain that text (one owner's launch, not another's). */
  outOfMemory(folder: string, whenArgsInclude?: string): void
  /** The JSON body the engine answers every POST with. */
  reply(body: unknown): void
  /** Every start so far, oldest first. */
  launches(): { folder: string; pid: number; args: string[] }[]
  /** Every non-probe request the engine served: method, path and body. */
  requests(): string[]
}

/** Install the fake as `<binDir>/<folder>/llama-server` for each engine folder given. */
export function installFakeLlamaEngine(
  binDir: string,
  folders: string[] = ['llama'],
  binaryName = 'llama-server'
): FakeLlamaEngine {
  for (const folder of folders) {
    const executable = path.join(binDir, folder, binaryName)
    fs.mkdirSync(path.dirname(executable), { recursive: true })
    fs.writeFileSync(executable, SCRIPT)
    fs.chmodSync(executable, 0o755)
  }
  const read = (name: string): string[] => {
    try {
      return fs.readFileSync(path.join(binDir, name), 'utf8').split('\n').filter(Boolean)
    } catch {
      return []
    }
  }
  return {
    binDir,
    hold: () => fs.writeFileSync(path.join(binDir, 'hold'), ''),
    release: () => fs.rmSync(path.join(binDir, 'hold'), { force: true }),
    outOfMemory: (folder, whenArgsInclude = '') =>
      fs.writeFileSync(path.join(binDir, `${folder}.oom`), whenArgsInclude),
    reply: (body) => fs.writeFileSync(path.join(binDir, 'reply.json'), JSON.stringify(body)),
    launches: () =>
      read('launches.log').map((line) => {
        const [folder = '', pid = '0', ...args] = line.split(' ')
        return { folder, pid: Number(pid), args }
      }),
    requests: () => read('requests.log')
  }
}

/** A minimal valid GGUF file (magic + padding), as the model import checks it. */
export function writeGguf(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  const bytes = Buffer.alloc(2048, 7)
  bytes.write('GGUF')
  fs.writeFileSync(file, bytes)
  return file
}

export async function unusedPort(): Promise<number> {
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

/** True while a process with this pid exists. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
