// A dedicated llama-server (grounding, decision) owned by DedicatedLlamaRuntime: it starts, comes
// back on its own when the engine dies, stops trying after repeated deaths, and stops cleanly.
// The native engine is the external boundary: a small process that implements llama-server's
// health contract and dies on request. Engine selection, ports, launch and recovery are real.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { binRoots, configureRuntime, dataDir } from '../../runtime-env'
import { DedicatedLlamaRuntime } from '../dedicated-llama-runtime'

const previous = { dataDir: dataDir(), binRoots: binRoots() }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-dedicated-runtime-'))
const binaries = path.join(profile, 'bin')
const engine = path.join(binaries, 'llama-cpu', 'llama-server')
/** What the engine does on its next start: serve, die once healthy, or never answer. */
const modeFile = path.join(profile, 'mode')
/** One line per engine start. */
const spawnLog = path.join(profile, 'spawns')
configureRuntime({ dataDir: profile, binRoots: [binaries] })

fs.mkdirSync(path.dirname(engine), { recursive: true })
fs.writeFileSync(
  engine,
  `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
fs.appendFileSync(${JSON.stringify(spawnLog)}, process.argv.slice(2).join(' ') + '\\n');
const mode = fs.existsSync(${JSON.stringify(modeFile)}) ? fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8').trim() : 'serve';
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const server = http.createServer((req, res) => {
  if (mode === 'silent') return;
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/health') {
    res.end(JSON.stringify({ status: 'ok' }));
    if (mode === 'fault') setTimeout(() => { process.stderr.write('CUDA error: device lost\\n'); process.exit(1); }, 150);
    return;
  }
  res.statusCode = 404; res.end('{}');
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`,
  { mode: 0o755 }
)

const spawns = (): number =>
  fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, 'utf8').trim().split('\n').length : 0

let runtime: DedicatedLlamaRuntime | undefined

function makeRuntime(readyTimeoutMs?: number): DedicatedLlamaRuntime {
  runtime = new DedicatedLlamaRuntime({
    id: 'decision',
    label: 'Decision',
    modality: 'decision',
    port: 30_000 + Math.floor(Math.random() * 20_000),
    ...(readyTimeoutMs ? { readyTimeoutMs } : {}),
    modelPaths: async () => ({
      model: 'test/decider',
      modelPath: path.join(profile, 'decider.gguf'),
      mmProjPath: ''
    }),
    extraArgs: () => ({
      effectiveCtxSize: 4_096,
      flashAttn: true,
      kvCacheType: 'q8_0',
      speculativeDecoding: 'off',
      threads: undefined,
      batchSize: 128
    })
  })
  return runtime
}

async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

afterEach(async () => {
  await runtime?.stop()
  runtime = undefined
  fs.rmSync(modeFile, { force: true })
  fs.rmSync(spawnLog, { force: true })
})

afterAll(() => {
  configureRuntime(previous)
  fs.rmSync(profile, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('DedicatedLlamaRuntime', () => {
  it('starts the engine on the CPU build and answers health', async () => {
    const decision = makeRuntime()
    await decision.start()
    expect(decision.isRunning).toBe(true)
    expect(decision.shouldBeRunning()).toBe(true)
    expect(await decision.health()).toBe(true)
    expect(decision.backend).toBe('CPU')
    // The CPU build runs CPU only.
    expect(fs.readFileSync(spawnLog, 'utf8')).toContain('--device none')
    // A second start while running is the same engine.
    await decision.start()
    expect(spawns()).toBe(1)
  })

  it('brings the same model back on its own after the engine dies', async () => {
    const decision = makeRuntime()
    fs.writeFileSync(modeFile, 'fault')
    await decision.start()
    fs.writeFileSync(modeFile, 'serve')
    await decision.health()
    // The engine dies after answering; the runtime starts it again with the same model.
    await until(async () => spawns() >= 2 && decision.isRunning && (await decision.health()))
    const starts = fs.readFileSync(spawnLog, 'utf8').trim().split('\n')
    expect(starts[1]).toContain(path.join(profile, 'decider.gguf'))
  })

  it('stops restarting after repeated deaths and says so', async () => {
    const decision = makeRuntime()
    fs.writeFileSync(modeFile, 'fault')
    await decision.start()
    // Each death is restarted with a growing pause, until the budget runs out.
    await until(() => decision.failureCode === 'startup', 30_000)
    expect(decision.isRunning).toBe(false)
    const before = spawns()
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(spawns()).toBe(before)
  }, 40_000)

  it('gives up on an engine that never becomes ready', async () => {
    const decision = makeRuntime(800)
    fs.writeFileSync(modeFile, 'silent')
    await expect(decision.start()).rejects.toThrow()
    expect(decision.isRunning).toBe(false)
  })

  it('restarts on request and stops cleanly', async () => {
    const decision = makeRuntime()
    await decision.start()
    await decision.restart()
    expect(spawns()).toBe(2)
    expect(await decision.health()).toBe(true)
    await decision.stop()
    expect(decision.isRunning).toBe(false)
    expect(decision.shouldBeRunning()).toBe(false)
    expect(await decision.health()).toBe(false)
    // Restarting a stopped runtime does nothing.
    await decision.restart()
    expect(spawns()).toBe(2)
  })
})
