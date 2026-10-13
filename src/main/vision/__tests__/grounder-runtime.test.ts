import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { configureRuntime, dataDir, binRoots } from '../../runtime-env'

const previousDataDir = dataDir()
const previousBinRoots = binRoots()
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-grounder-runtime-'))
const binaries = path.join(profile, 'bin')
const engine = path.join(binaries, 'llama-cpu', 'llama-server')
const modelId = 'bartowski/tencent_UI-Mate-9B-GGUF'
configureRuntime({ dataDir: profile, binRoots: [binaries] })
const { GrounderRuntime } = await import('../grounder-runtime')
let runtime: InstanceType<typeof GrounderRuntime> | undefined

// The native engine is an external boundary. Run a small process that implements
// its health and OpenAI HTTP contracts; keep model resolution, ports and shutdown real.
function writeEngine(fail = false): void {
  fs.mkdirSync(path.dirname(engine), { recursive: true })
  fs.writeFileSync(
    engine,
    '#!/usr/bin/env node\n' +
      (fail
        ? "process.stderr.write('Metal allocation failed: out of memory\\n'); process.exit(1);\n"
        : `const http = require('node:http');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/health') return res.end(JSON.stringify({status: 'ok'}));
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    req.resume();
    req.on('end', () => res.end(JSON.stringify({
      id: 'synthetic-grounding', object: 'chat.completion',
      choices: [{index: 0, message: {role: 'assistant', content: 'Click the button.'}, finish_reason: 'stop'}]
    })));
    return;
  }
  res.statusCode = 404; res.end('{}');
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`),
    { mode: 0o755 }
  )
}

beforeAll(() => {
  const models = path.join(profile, 'models')
  fs.mkdirSync(models)
  for (const name of ['tencent_UI-Mate-9B-Q4_K_M.gguf', 'mmproj-tencent_UI-Mate-9B-f16.gguf']) {
    fs.writeFileSync(
      path.join(models, name),
      Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(2048)])
    )
  }
})

afterEach(async () => {
  await runtime?.shutdown()
  runtime = undefined
})

afterAll(() => {
  configureRuntime({ dataDir: previousDataDir, binRoots: previousBinRoots })
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('GrounderRuntime', () => {
  it.skipIf(process.platform === 'win32')(
    'serves grounding requests and closes its dedicated connection',
    async () => {
      writeEngine()
      configureRuntime({ binRoots: [binaries] })
      runtime = new GrounderRuntime()
      const connection = await runtime.connection(modelId)
      expect(connection.model).toBe(modelId)
      expect(runtime.running).toBe(true)
      const response = await fetch(`${connection.endpoint}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Find the button.' }] })
      })
      expect(response.ok).toBe(true)
      expect((await response.json()).choices[0].message.content).toBe('Click the button.')
      expect((await runtime.connection(modelId)).endpoint).toBe(connection.endpoint)
      await runtime.shutdown()
      expect(runtime.running).toBe(false)
      await expect(fetch(`${connection.endpoint}/models`)).rejects.toThrow()
    }
  )

  it('rejects missing models and missing engines', async () => {
    configureRuntime({ binRoots: [path.join(profile, 'missing-bin')] })
    runtime = new GrounderRuntime()
    await expect(runtime.connection('missing')).rejects.toThrow('not installed')
    await expect(runtime.connection(modelId)).rejects.toThrow('engine is missing')
  })

  it.skipIf(process.platform === 'win32')(
    'reports memory guidance when the engine exits during startup',
    async () => {
      writeEngine(true)
      configureRuntime({ binRoots: [binaries] })
      runtime = new GrounderRuntime()
      await expect(runtime.connection(modelId)).rejects.toThrow('does not have enough free memory')
      expect(runtime.running).toBe(false)
    }
  )
})
