#!/usr/bin/env node
// Stage a platform's engine folders as updatable engines (see src/shared/engine-updates.ts).
//
//   node scripts/stage-engines.mjs --platform darwin|linux|win32 --bin <bin root> --out <dir> [--pins <file>]
//
// Each engine folder under the bin root (for example `llama/` or `sd-cuda/`) becomes
// `<out>/<id>/<id>/...` with an engine.json beside it, versioned from resources/engine-pins.json,
// ready for scripts/publish-engine.mjs. Folders the platform does not have are skipped. A CUDA
// engine folder without its own CUDA runtime takes the shared `cuda-runtime/` with it. The upstream CUDA chat engine is
// staged separately by scripts/stage-llama-engine.mjs, with its CUDA runtime.
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    platform: { type: 'string' },
    bin: { type: 'string' },
    out: { type: 'string' },
    pins: { type: 'string' }
  }
})
const { platform } = values
if (!['darwin', 'linux', 'win32'].includes(platform) || !values.bin || !values.out) {
  console.error(
    'Usage: stage-engines.mjs --platform darwin|linux|win32 --bin <bin root> --out <dir>'
  )
  process.exit(1)
}
const pins = JSON.parse(
  fs.readFileSync(values.pins ?? new URL('../resources/engine-pins.json', import.meta.url), 'utf8')
)
const exe = (name) => (platform === 'win32' ? `${name}.exe` : name)

// id -> [pinned engine, executable, needs an NVIDIA GPU]. On Windows the `whisper` folder holds
// the CUDA build (the CPU build is `whisper-cpu`), as fetch-win-binaries.ps1 stages it.
const ENGINES = {
  darwin: {
    llama: ['llama', 'llama-server', false],
    'llama-prism': ['prism', 'llama-server', false],
    sd: ['sd', 'sd-cli', false],
    whisper: ['whisper', 'whisper-cli', false]
  },
  linux: {
    llama: ['llama', 'llama-server', false],
    'llama-cpu': ['llama', 'llama-server', false],
    'llama-prism': ['prism', 'llama-server', false],
    'llama-prism-cpu': ['prism', 'llama-server', false],
    'llama-prism-cuda': ['prism', 'llama-server', true],
    sd: ['sd', 'sd-cli', false],
    'sd-cuda': ['sd', 'sd-cli', true],
    whisper: ['whisper', 'whisper-cli', false],
    'whisper-cpu': ['whisper', 'whisper-cli', false],
    'whisper-cuda': ['whisper', 'whisper-cli', true]
  },
  win32: {
    llama: ['llama', 'llama-server', false],
    'llama-cpu': ['llama', 'llama-server', false],
    'llama-prism': ['prism', 'llama-server', false],
    'llama-prism-cpu': ['prism', 'llama-server', false],
    'llama-prism-cuda': ['prism', 'llama-server', true],
    sd: ['sd', 'sd-cli', false],
    'sd-cpu': ['sd', 'sd-cli', false],
    'sd-cuda': ['sd', 'sd-cli', true],
    whisper: ['whisper', 'whisper-cli', true],
    'whisper-cpu': ['whisper', 'whisper-cli', false]
  }
}[platform]

const bin = path.resolve(values.bin)
const out = path.resolve(values.out)
const staged = []
for (const [id, [engine, executable, nvidia]] of Object.entries(ENGINES)) {
  const source = path.join(bin, id)
  if (!fs.existsSync(path.join(source, exe(executable)))) continue
  const target = path.join(out, id)
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  // verbatimSymlinks keeps the Linux and macOS library links as links.
  fs.cpSync(source, path.join(target, id), { recursive: true, verbatimSymlinks: true })
  // A CUDA engine without its own CUDA runtime loads it from `cuda-runtime/` beside its folder
  // (engineSpawnEnv, sdRuntimeLibraryEnv), so that folder ships with it, or it cannot start.
  const ownRuntime = fs.readdirSync(source).some((file) => /^(lib)?cudart/i.test(file))
  if (nvidia && !ownRuntime) {
    const runtime = path.join(bin, 'cuda-runtime')
    if (!fs.existsSync(runtime)) throw new Error(`${id} needs ${runtime}, which is missing`)
    fs.cpSync(runtime, path.join(target, 'cuda-runtime'), {
      recursive: true,
      verbatimSymlinks: true
    })
  }
  const release = {
    id,
    version: pins[engine].ref,
    // The oldest app that can run this version (scripts/engine-floors.mjs); publish signs it into the index.
    ...(pins[engine].minApp ? { minApp: pins[engine].minApp } : {}),
    smokeTest: `${id}/${exe(executable)}`,
    ...(nvidia ? { requires: 'nvidia' } : {})
  }
  fs.writeFileSync(path.join(target, 'engine.json'), `${JSON.stringify(release, null, 2)}\n`)
  staged.push(`${id} ${release.version}`)
}
if (!staged.length) throw new Error(`No engines found under ${bin}`)
console.log(`Staged for ${platform}: ${staged.join(', ')}`)
