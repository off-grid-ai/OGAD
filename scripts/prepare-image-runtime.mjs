#!/usr/bin/env node
// The same pinned source and decode observers feed each native image/video build.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const scripts = dirname(fileURLToPath(import.meta.url))
const source = process.argv[2] && resolve(process.argv[2])
if (!source) throw new Error('Usage: prepare-image-runtime.mjs <source-directory> [ref]')
// The engine pin is the one source of the stable-diffusion.cpp version; a ref argument overrides it.
const pins = JSON.parse(readFileSync(resolve(scripts, '../resources/engine-pins.json'), 'utf8'))
const revision = process.argv[3] || pins.sd.commit
// Each patch applies inside its own tree: stable-diffusion.cpp itself, or its ggml submodule.
// ggml's Metal GroupNorm normalized only the first image of a batch; sd.cpp batches CFG's two UNet
// passes, so the second came back unwritten and every SDXL picture on a Mac rendered white.
const patches = [
  { tree: '.', name: 'video-decode-observer.patch' },
  { tree: '.', name: 'video-decode-cli.patch' },
  { tree: 'ggml', name: 'metal-group-norm-batch.patch' }
].map(({ tree, name }) => ({ dir: resolve(source, tree), file: resolve(scripts, 'patches', name) }))
const git = (...args) => execFileSync('git', ['-C', source, ...args], { stdio: 'inherit' })
if (!existsSync(resolve(source, '.git'))) {
  execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout',
    'https://github.com/leejet/stable-diffusion.cpp.git', source], { stdio: 'inherit' })
}
for (const { dir, file } of [...patches].reverse()) {
  if (!existsSync(dir)) continue
  try {
    execFileSync('git', ['-C', dir, 'apply', '--reverse', '--check', file], { stdio: 'ignore' })
  } catch { continue }
  execFileSync('git', ['-C', dir, 'apply', '--reverse', file], { stdio: 'inherit' })
}
git('fetch', '--depth', '1', 'origin', revision)
git('checkout', '--detach', 'FETCH_HEAD')
// Recursive: newer ggml carries CUTLASS as its own submodule, which the CUDA build needs.
git('submodule', 'update', '--init', '--recursive', '--depth', '1', 'ggml')
if (execFileSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) {
  throw new Error(`Native source has unrelated changes: ${source}`)
}
for (const { dir, file } of patches) execFileSync('git', ['-C', dir, 'apply', file], { stdio: 'inherit' })
