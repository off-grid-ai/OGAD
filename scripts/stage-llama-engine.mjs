#!/usr/bin/env node
// Stage an official llama.cpp CUDA release as an updatable engine (see src/shared/engine-updates.ts).
//
//   node scripts/stage-llama-engine.mjs --platform linux --ref b11551 --out build/engines/linux
//   node scripts/stage-llama-engine.mjs --platform win32 --ref b11551 --out build/engines/win32
//
// Downloads the ggml-org release asset, checks it against the SHA-256 GitHub publishes for it, and
// lays it out exactly as the app's own builds do (scripts/build-llama-linux.sh and
// scripts/fetch-win-binaries.ps1): `llama-cuda/` beside `cuda-runtime/`. Then publish the folder with
// scripts/publish-engine.mjs. Linux staging copies the runner's libgomp, so run it on Linux x64 or
// pass --gomp with a Linux libgomp.so.1.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    platform: { type: 'string' },
    ref: { type: 'string' },
    out: { type: 'string' },
    gomp: { type: 'string' }
  }
})
const platform = values.platform
const ref = values.ref
if (!['linux', 'win32'].includes(platform) || !/^b\d+$/.test(ref ?? '') || !values.out) {
  console.error(
    'Usage: stage-llama-engine.mjs --platform linux|win32 --ref b<build> --out <dir> [--gomp <libgomp.so.1>]'
  )
  process.exit(1)
}
const out = path.resolve(values.out)
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-engine-'))
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }))

// Linux CUDA runtime libraries come from one pinned upstream archive, the same one the CUDA pack
// ships, so a machine with the pack already has these files and downloads none of them.
const LINUX_CUDART = {
  ref: 'b11669',
  name: 'cudart-llama-b11669-bin-ubuntu-cuda-12.8-x64.tar.gz',
  sha256: 'ab3eda89a82096bcba00b6448218c3c11eec2016b0f38d64884dc29736549f26'
}

async function releaseAsset(tag, name) {
  const response = await fetch(
    `https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${tag}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
      }
    }
  )
  if (!response.ok) throw new Error(`GitHub release ${tag}: HTTP ${response.status}`)
  const release = await response.json()
  const asset = release.assets?.find((item) => item.name === name)
  if (!asset) throw new Error(`Release ${tag} has no asset named ${name}`)
  const digest = /^sha256:([a-f0-9]{64})$/.exec(asset.digest ?? '')?.[1]
  if (!digest) throw new Error(`GitHub reports no SHA-256 for ${name}`)
  return { url: asset.browser_download_url, sha256: digest }
}

async function download(url, sha256, name) {
  const file = path.join(work, name)
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`Download ${name}: HTTP ${response.status}`)
  const hash = createHash('sha256')
  const stream = fs.createWriteStream(file)
  for await (const chunk of response.body) {
    hash.update(chunk)
    if (!stream.write(chunk)) await new Promise((resolve) => stream.once('drain', resolve))
  }
  await new Promise((resolve, reject) => stream.end((error) => (error ? reject(error) : resolve())))
  const actual = hash.digest('hex')
  if (actual !== sha256) throw new Error(`${name} SHA-256 ${actual} does not match ${sha256}`)
  console.log(`verified ${name} ${sha256}`)
  return file
}

function extract(archive, into) {
  fs.mkdirSync(into, { recursive: true })
  if (archive.endsWith('.zip'))
    execFileSync('unzip', ['-q', archive, '-d', into], { stdio: 'inherit' })
  else execFileSync('tar', ['-xzf', archive, '-C', into], { stdio: 'inherit' })
}

/** The single folder an archive unpacked into, or the folder itself when files sit at its top. */
function contentRoot(folder) {
  const entries = fs.readdirSync(folder)
  return entries.length === 1 && fs.statSync(path.join(folder, entries[0])).isDirectory()
    ? path.join(folder, entries[0])
    : folder
}

function copyMatching(from, to, test) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from)) {
    if (!test(entry)) continue
    // Keep versioned .so symlinks as links; dereferencing them duplicates each library.
    fs.cpSync(path.join(from, entry), path.join(to, entry), {
      verbatimSymlinks: true,
      recursive: true
    })
  }
}

function linuxGomp() {
  if (values.gomp) return values.gomp
  const listing = execFileSync('ldconfig', ['-p'], { encoding: 'utf8' })
  const match = listing.split('\n').find((line) => /libgomp\.so\.1 /.test(line))
  const file = match?.split('=>').pop()?.trim()
  if (!file) throw new Error('libgomp.so.1 not found; pass --gomp')
  return fs.realpathSync(file)
}

fs.rmSync(out, { recursive: true, force: true })
const engineDir = path.join(out, 'llama-cuda')
const runtimeDir = path.join(out, 'cuda-runtime')

if (platform === 'linux') {
  const name = `llama-${ref}-bin-ubuntu-cuda-12.8-x64.tar.gz`
  const asset = await releaseAsset(ref, name)
  const unpacked = path.join(work, 'engine')
  extract(await download(asset.url, asset.sha256, name), unpacked)
  const source = contentRoot(unpacked)
  if (
    !fs.existsSync(path.join(source, 'llama-server')) ||
    !fs.existsSync(path.join(source, 'libggml-cuda.so'))
  ) {
    throw new Error(`${name} does not contain llama-server and libggml-cuda.so`)
  }
  copyMatching(
    source,
    engineDir,
    (entry) => entry === 'llama-server' || entry === 'LICENSE' || /^lib.*\.so/.test(entry)
  )
  fs.copyFileSync(linuxGomp(), path.join(engineDir, 'libgomp.so.1'))
  fs.chmodSync(path.join(engineDir, 'llama-server'), 0o755)

  const cudartUnpacked = path.join(work, 'cudart')
  extract(
    await download(
      `https://github.com/ggml-org/llama.cpp/releases/download/${LINUX_CUDART.ref}/${LINUX_CUDART.name}`,
      LINUX_CUDART.sha256,
      LINUX_CUDART.name
    ),
    cudartUnpacked
  )
  copyMatching(contentRoot(cudartUnpacked), runtimeDir, (entry) => /^lib.*\.so\.12$/.test(entry))
} else {
  const name = `llama-${ref}-bin-win-cuda-12.4-x64.zip`
  const asset = await releaseAsset(ref, name)
  const unpacked = path.join(work, 'engine')
  extract(await download(asset.url, asset.sha256, name), unpacked)
  const source = contentRoot(unpacked)
  if (!fs.existsSync(path.join(source, 'llama-server.exe')))
    throw new Error(`${name} has no llama-server.exe`)
  copyMatching(source, engineDir, () => true)
  const cudartName = 'cudart-llama-bin-win-cuda-12.4-x64.zip'
  const cudart = await releaseAsset(ref, cudartName)
  const cudartUnpacked = path.join(work, 'cudart')
  extract(await download(cudart.url, cudart.sha256, cudartName), cudartUnpacked)
  copyMatching(contentRoot(cudartUnpacked), runtimeDir, () => true)
}

const smokeTest = platform === 'win32' ? 'llama-cuda/llama-server.exe' : 'llama-cuda/llama-server'
fs.writeFileSync(
  path.join(out, 'engine.json'),
  `${JSON.stringify({ id: 'llama-cuda', version: ref, smokeTest }, null, 2)}\n`
)
console.log(`staged llama-cuda ${ref} for ${platform} in ${out}`)
