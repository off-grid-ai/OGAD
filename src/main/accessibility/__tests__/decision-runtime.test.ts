/**
 * The Decision runtime starts a local model server, asks it to choose, and stops it. The
 * executables are the only fake: llama-server (harness/fake-llama-engine) for the Decider, and
 * Kev's Python server for Kev. Model files sit in a temp models folder the way a download leaves
 * them; the catalog, artifact resolution, engine ladder, ports, launch arguments and the HTTP
 * calls are production code.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installFakeLlamaEngine,
  processAlive,
  writeGguf,
  type FakeLlamaEngine
} from '../../__tests__/harness/fake-llama-engine'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-decision-runtime-'))
const previous = { data: process.env.OFFGRID_DATA_DIR, bin: process.env.OFFGRID_BIN_DIR }
process.env.OFFGRID_DATA_DIR = ROOT

vi.mock('electron', () => ({
  app: { getPath: () => ROOT, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

import { DecisionRuntime, DecisionRuntimeError } from '../decision-runtime'
import { DECIDER_2B, KEV_4B_ID, KEV_9B_ID, KEV_MODELS } from '../../models-manager'
import { llm } from '../../llm'

// Kev's server: answers /v1/models once loaded and /v1/systemone with kev-reply.json, and logs
// how it was started so a test can see which checkpoint and base it was given.
const KEV_SERVER = `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const root = path.resolve(__dirname, '../../..')
const args = process.argv.slice(2)
fs.appendFileSync(path.join(root, 'kev.log'), JSON.stringify({ pid: process.pid, args, cwd: process.cwd(), base: process.env.KEV_LOCAL_BASE }) + '\\n')
process.stderr.write('[Kev] loaded: device=cpu\\n')
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  if (req.url === '/v1/models') return res.end('{"data":[{"id":"kev-latest"}]}')
  req.resume()
  req.on('end', () => res.end(fs.readFileSync(path.join(root, 'kev-reply.json'))))
}).listen(Number(args[args.indexOf('--port') + 1]), '127.0.0.1')
process.on('SIGTERM', () => process.exit(0))
`

let bin: string
let engine: FakeLlamaEngine
const runtimes: DecisionRuntime[] = []

function runtime(): DecisionRuntime {
  const created = new DecisionRuntime()
  runtimes.push(created)
  return created
}

function modelsDir(): string {
  return llm.getModelsDir()
}

/** The Decider's GGUF, where its download puts it. */
function installDecider(): void {
  writeGguf(modelsDir(), DECIDER_2B.files[0]!.name)
}

/** A Kev model's checkpoint and base files, where its download puts them. */
function installKev(modelId: string): { checkpoint: string; base: string } {
  const folder = KEV_MODELS.find((model) => model.id === modelId)!.files[0]!.name.split('/')[0]!
  const checkpoint = path.join(modelsDir(), folder, 'checkpoint-v1.0')
  const base = path.join(modelsDir(), folder, 'base')
  const write = (file: string, body = 'weights'): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
  }
  write(path.join(checkpoint, 'head.pt'))
  write(path.join(checkpoint, 'adapter_model.safetensors'))
  write(path.join(base, 'config.json'), '{}')
  write(path.join(base, 'model.safetensors.index.json'), JSON.stringify({ weight_map: { a: 'model-1.safetensors' } }))
  write(path.join(base, 'model-1.safetensors'))
  write(path.join(base, 'tokenizer.json'), '{}')
  write(path.join(base, 'tokenizer_config.json'), '{}')
  return { checkpoint: checkpoint + path.sep, base }
}

function kevStarts(): { pid: number; args: string[]; cwd: string; base: string }[] {
  try {
    return fs
      .readFileSync(path.join(bin, 'kev.log'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

const kevReply = (body: unknown): void =>
  fs.writeFileSync(path.join(bin, 'kev-reply.json'), JSON.stringify(body))

/** llama-server's /completion body for one forced token with these option probabilities. */
const tokenProbabilities = (probs: Record<string, number>) => ({
  content: 'B',
  completion_probabilities: [
    { top_probs: Object.entries(probs).map(([token, prob]) => ({ token, prob })) }
  ]
})

beforeEach(() => {
  fs.rmSync(path.join(ROOT, 'models'), { recursive: true, force: true })
  bin = fs.mkdtempSync(path.join(ROOT, 'bin-'))
  process.env.OFFGRID_BIN_DIR = bin
  engine = installFakeLlamaEngine(bin, ['llama'])
  const python = path.join(bin, 'kev-runtime', 'python', 'bin', 'python3')
  fs.mkdirSync(path.dirname(python), { recursive: true })
  fs.writeFileSync(python, KEV_SERVER, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'kev-local-server.py'), '# Kev server\n')
})

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((created) => created.shutdown()))
  for (const { pid } of [...engine.launches(), ...kevStarts()])
    if (processAlive(pid)) process.kill(pid, 'SIGKILL')
})

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
  if (previous.data === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previous.data
  if (previous.bin === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = previous.bin
})

describe('DecisionRuntime', () => {
  it('starts, reuses, decides with, checks, and stops a local decision server', async () => {
    installDecider()
    engine.reply(tokenProbabilities({ A: 0.2, B: 0.8 }))
    const decision = runtime()
    await decision.start(DECIDER_2B.id)

    expect(decision.running).toBe(true)
    expect(decision.activeModelId).toBe(DECIDER_2B.id)
    const [launch] = engine.launches()
    const modelArg = launch!.args[launch!.args.indexOf('-m') + 1]!
    expect(fs.realpathSync(modelArg)).toBe(
      fs.realpathSync(path.join(modelsDir(), DECIDER_2B.files[0]!.name))
    )
    expect(launch?.args).toContain(String(decision.activePort))

    await decision.start(DECIDER_2B.id)
    expect(engine.launches()).toHaveLength(1)
    await expect(decision.decide('state', 'next?', ['A', 'B'])).resolves.toEqual({
      choice: 1,
      confidence: 0.8,
      probabilities: [0.2, 0.8]
    })
    expect(engine.requests().some((line) => line.startsWith('POST /completion'))).toBe(true)
    await expect(decision.health()).resolves.toBe(true)

    await decision.shutdown()
    expect(processAlive(launch!.pid)).toBe(false)
    expect(decision.running).toBe(false)
    expect(decision.activeModelId).toBeNull()
    await expect(decision.health()).resolves.toBe(false)
    await expect(decision.decide('state', 'next?', ['A'])).rejects.toMatchObject({
      code: 'startup'
    })
  })

  it('reports a missing model, exhausted ports, and a missing engine', async () => {
    await expect(runtime().start(DECIDER_2B.id)).rejects.toEqual(
      expect.objectContaining<Partial<DecisionRuntimeError>>({ code: 'missing' })
    )

    installDecider()
    // Every port the runtime may use (8459 and the 19 after it) is held by another program.
    const held: http.Server[] = []
    for (let port = 8459; port < 8479; port++) {
      const server = http.createServer()
      await new Promise<void>((resolve) => {
        server.once('error', () => resolve())
        server.listen(port, '127.0.0.1', () => resolve())
      })
      held.push(server)
    }
    try {
      await expect(runtime().start(DECIDER_2B.id)).rejects.toThrow('No private port')
    } finally {
      await Promise.all(held.map((server) => new Promise((resolve) => server.close(resolve))))
    }

    fs.rmSync(path.join(bin, 'llama'), { recursive: true, force: true })
    await expect(runtime().start(DECIDER_2B.id)).rejects.toThrow('engine is missing')
    expect(engine.launches()).toHaveLength(0)
  })

  it('uses the Kev choice endpoint and normalizes its distribution', async () => {
    const { checkpoint } = installKev(KEV_4B_ID)
    kevReply({
      answers: {
        decision: { choice: 'option_1', probabilities: { option_0: 2, option_1: 6, option_2: 2 } }
      }
    })
    const decision = runtime()
    await decision.start(KEV_4B_ID)
    await expect(decision.decide('screen', 'next?', ['A', 'B', 'C'])).resolves.toEqual({
      choice: 1,
      confidence: 0.6,
      probabilities: [0.2, 0.6, 0.2]
    })
    const [start] = kevStarts()
    expect(start?.args).toEqual([
      path.join(bin, 'kev-local-server.py'),
      '--run',
      checkpoint,
      '--port',
      String(decision.activePort)
    ])
    expect(fs.realpathSync(start!.cwd)).toBe(fs.realpathSync(checkpoint))
  })

  it('runs Kev 9B on its own installed checkpoint through the same Kev endpoint', async () => {
    installKev(KEV_4B_ID)
    const { checkpoint, base } = installKev(KEV_9B_ID)
    kevReply({
      answers: { decision: { choice: 'option_0', probabilities: { option_0: 3, option_1: 1 } } }
    })
    const decision = runtime()
    await decision.start(KEV_9B_ID)
    const [start] = kevStarts()
    expect(start?.args[2]).toBe(checkpoint)
    expect(start?.base).toBe(base)
    await expect(decision.decide('screen', 'next?', ['A', 'B'])).resolves.toEqual({
      choice: 0,
      confidence: 0.75,
      probabilities: [0.75, 0.25]
    })
  })

  it('rejects invalid Kev responses and classifies startup memory failures', async () => {
    installKev(KEV_4B_ID)
    kevReply({ answers: { decision: { choice: 'unknown', probabilities: {} } } })
    const kev = runtime()
    await kev.start(KEV_4B_ID)
    await expect(kev.decide('screen', 'next?', ['A'])).rejects.toThrow('invalid Decision response')
    await kev.shutdown()

    // The GPU engine runs out of memory, then the same engine CPU-only does too.
    installDecider()
    engine.outOfMemory('llama')
    await expect(runtime().start(DECIDER_2B.id)).rejects.toMatchObject({ code: 'out_of_memory' })
    expect(engine.launches()).toHaveLength(2)
  })
})
