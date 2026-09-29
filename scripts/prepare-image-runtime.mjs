#!/usr/bin/env node
// The same pinned source and decode observers feed each native image/video build.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const scripts = dirname(fileURLToPath(import.meta.url))
const source = process.argv[2] && resolve(process.argv[2])
if (!source) throw new Error('Usage: prepare-image-runtime.mjs <source-directory>')
const revision = '3f8527a46c54ecf4cb4ed6003da8e8982283c73c'
const patches = ['video-decode-observer.patch', 'video-decode-cli.patch']
  .map(name => resolve(scripts, 'patches', name))
const git = (...args) => execFileSync('git', ['-C', source, ...args], { stdio: 'inherit' })
if (!existsSync(resolve(source, '.git'))) {
  execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout',
    'https://github.com/leejet/stable-diffusion.cpp.git', source], { stdio: 'inherit' })
}
for (const patch of [...patches].reverse()) {
  try {
    execFileSync('git', ['-C', source, 'apply', '--reverse', '--check', patch], { stdio: 'ignore' })
  } catch { continue }
  git('apply', '--reverse', patch)
}
git('fetch', 'origin', revision)
git('checkout', '--detach', revision)
git('submodule', 'update', '--init', '--depth', '1', 'ggml')
if (execFileSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) {
  throw new Error(`Native source has unrelated changes: ${source}`)
}
for (const patch of patches) git('apply', patch)
