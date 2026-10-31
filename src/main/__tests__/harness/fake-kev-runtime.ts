// Kev's local server, as the executable the app starts: `<bin>/kev-runtime/python/bin/python3`
// running `<bin>/kev-local-server.py`. This stand-in answers /v1/models once loaded and
// /v1/systemone with `kev-reply.json`, logs how it was started (args, cwd, KEV_LOCAL_BASE) to
// `kev.log`, and runs out of memory while loading when `kev.oom` exists. Model files are laid out
// where a Kev download puts them.
import fs from 'node:fs'
import path from 'node:path'
import { KEV_MODELS } from '../../models-manager'

const KEV_SERVER = `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const root = path.resolve(__dirname, '../../..')
const args = process.argv.slice(2)
fs.appendFileSync(path.join(root, 'kev.log'), JSON.stringify({ pid: process.pid, args, cwd: process.cwd(), base: process.env.KEV_LOCAL_BASE }) + '\\n')
if (fs.existsSync(path.join(root, 'kev.oom'))) {
  process.stderr.write('torch.OutOfMemoryError: CUDA out of memory\\n')
  process.exit(1)
}
process.stderr.write('[Kev] loaded: device=cpu\\n')
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  if (req.url === '/v1/models') return res.end('{"data":[{"id":"kev-latest"}]}')
  req.resume()
  req.on('end', () => res.end(fs.readFileSync(path.join(root, 'kev-reply.json'))))
}).listen(Number(args[args.indexOf('--port') + 1]), '127.0.0.1')
process.on('SIGTERM', () => process.exit(0))
`

export interface KevStart {
  pid: number
  args: string[]
  cwd: string
  base: string
}

export interface FakeKevRuntime {
  starts(): KevStart[]
  reply(body: unknown): void
  outOfMemory(on: boolean): void
}

/** Install Kev's runtime under `binDir` (the app's OFFGRID_BIN_DIR). */
export function installFakeKevRuntime(binDir: string): FakeKevRuntime {
  const python = path.join(binDir, 'kev-runtime', 'python', 'bin', 'python3')
  fs.mkdirSync(path.dirname(python), { recursive: true })
  fs.writeFileSync(python, KEV_SERVER, { mode: 0o755 })
  fs.writeFileSync(path.join(binDir, 'kev-local-server.py'), '# Kev server\n')
  return {
    starts: () => {
      try {
        return fs
          .readFileSync(path.join(binDir, 'kev.log'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as KevStart)
      } catch {
        return []
      }
    },
    reply: (body) => fs.writeFileSync(path.join(binDir, 'kev-reply.json'), JSON.stringify(body)),
    outOfMemory: (on) =>
      on
        ? fs.writeFileSync(path.join(binDir, 'kev.oom'), '')
        : fs.rmSync(path.join(binDir, 'kev.oom'), { force: true })
  }
}

/** A Kev model's checkpoint and base files, where its download puts them under `modelsDir`. */
export function installKevModel(
  modelsDir: string,
  modelId: string
): { checkpoint: string; base: string } {
  const folder = KEV_MODELS.find((model) => model.id === modelId)!.files[0]!.name.split('/')[0]!
  const checkpoint = path.join(modelsDir, folder, 'checkpoint-v1.0')
  const base = path.join(modelsDir, folder, 'base')
  const write = (file: string, body = 'weights'): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
  }
  write(path.join(checkpoint, 'head.pt'))
  write(path.join(checkpoint, 'adapter_model.safetensors'))
  write(path.join(base, 'config.json'), '{}')
  write(
    path.join(base, 'model.safetensors.index.json'),
    JSON.stringify({ weight_map: { a: 'model-1.safetensors' } })
  )
  write(path.join(base, 'model-1.safetensors'))
  write(path.join(base, 'tokenizer.json'), '{}')
  write(path.join(base, 'tokenizer_config.json'), '{}')
  return { checkpoint: checkpoint + path.sep, base }
}
