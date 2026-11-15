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
// ggml 1.0.0 (sd.cpp master-1104) normalizes every image of a batch in Metal GroupNorm itself, so
// our metal-group-norm-batch.patch (white SDXL pictures on a Mac) is gone.
const patches = [
  { tree: '.', name: 'video-decode-observer.patch' },
  { tree: '.', name: 'video-decode-cli.patch' }
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
// The CUDA build needs CUTLASS: sd.cpp master-1104 carries it in thirdparty/cutlass, older ggml
// carried it as its own submodule (hence recursive).
git('submodule', 'update', '--init', '--recursive', '--depth', '1', 'ggml', 'thirdparty/cutlass')
if (execFileSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) {
  throw new Error(`Native source has unrelated changes: ${source}`)
}
for (const { dir, file } of patches) execFileSync('git', ['-C', dir, 'apply', file], { stdio: 'inherit' })
