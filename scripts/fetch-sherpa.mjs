#!/usr/bin/env node
// Stage the sherpa-onnx speech-to-text CLI that runs Parakeet into <bin root>/parakeet, from the
// upstream release pinned in resources/engine-pins.json (`sherpa`). Every platform takes the
// project's own prebuilt shared build, checked against the SHA-256 GitHub publishes for it:
//   macOS    osx-universal2-shared      bin/sherpa-onnx-offline + lib/libonnxruntime.dylib
//   Linux    linux-x64-shared           bin/sherpa-onnx-offline + lib/libonnxruntime.so
//   Windows  win-x64-shared-MT-Release  bin/sherpa-onnx-offline.exe + onnxruntime*.dll beside it
// The binaries find ONNX Runtime through their own rpath ($ORIGIN/../lib, @loader_path/../lib) or,
// on Windows, the executable's folder, so the layout is kept as upstream ships it. Only the one CLI
// and the library it links are copied; the archive's other ~25 tools are not shipped.
//
//   node scripts/fetch-sherpa.mjs [--bin <bin root>] [--check]
//
// --bin defaults to resources/bin (macOS, Windows, a dev checkout); Linux releases package
// build/linux-bin. --check runs the staged CLI once and fails unless it prints its usage.
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({
  options: { bin: { type: 'string' }, check: { type: 'boolean', default: false } }
})
const pins = JSON.parse(fs.readFileSync(path.join(root, 'resources', 'engine-pins.json'), 'utf8'))
const { repo, ref, sha256 } = pins.sherpa

/** The pinned upstream asset for this platform, and the files it ships. */
const TARGETS = {
  darwin: {
    key: 'mac-universal',
    asset: `sherpa-onnx-${ref}-osx-universal2-shared.tar.bz2`,
    files: { 'bin/sherpa-onnx-offline': 'bin', 'lib/libonnxruntime.dylib': 'lib' }
  },
  linux: {
    key: 'linux-x64',
    asset: `sherpa-onnx-${ref}-linux-x64-shared.tar.bz2`,
    files: { 'bin/sherpa-onnx-offline': 'bin', 'lib/libonnxruntime.so': 'lib' }
  },
  win32: {
    key: 'win-x64',
    asset: `sherpa-onnx-${ref}-win-x64-shared-MT-Release.tar.bz2`,
    files: {
      'bin/sherpa-onnx-offline.exe': 'bin',
      'bin/onnxruntime.dll': 'bin',
      'bin/onnxruntime_providers_shared.dll': 'bin'
    }
  }
}
// The licences the shipped files carry: sherpa-onnx (Apache-2.0) and ONNX Runtime (MIT), at the
// versions this release was built from (its CMake pins ONNX Runtime 1.28.2).
const LICENSES = {
  LICENSE: `https://raw.githubusercontent.com/${repo}/${ref}/LICENSE`,
  'LICENSE-onnxruntime': 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.28.2/LICENSE'
}

const target = TARGETS[process.platform]
if (!target) {
  console.error(`[sherpa] no pinned sherpa-onnx build for ${process.platform}`)
  process.exit(1)
}
const expected = sha256[target.key]
if (!/^[0-9a-f]{64}$/.test(expected ?? '')) {
  console.error(`[sherpa] engine-pins.json has no sha256 for ${target.key}`)
  process.exit(1)
}

async function download(url) {
  const response = await fetch(url, {
    headers: process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}
  })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

const binRoot = path.resolve(root, values.bin ?? path.join('resources', 'bin'))
const dest = path.join(binRoot, 'parakeet')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-sherpa-'))
try {
  const url = `https://github.com/${repo}/releases/download/${ref}/${target.asset}`
  console.log(`[sherpa] ${url}`)
  const archive = await download(url)
  const actual = crypto.createHash('sha256').update(archive).digest('hex')
  if (actual !== expected)
    throw new Error(`sha256 mismatch for ${target.asset}: got ${actual}, pinned ${expected}`)
  const tarball = path.join(work, target.asset)
  fs.writeFileSync(tarball, archive)

  // Windows: the system bsdtar reads bzip2 itself; Git Bash's tar may not.
  const tar =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
  const listing = spawnSync(tar, ['-tf', tarball], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  if (listing.status !== 0) throw new Error(`could not list ${target.asset}: ${listing.stderr}`)
  // A tampered archive must not write outside the temp folder.
  if (
    listing.stdout
      .split(/\r?\n/)
      .some((entry) => /^[\\/]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$)/.test(entry))
  )
    throw new Error(`${target.asset} holds absolute or parent paths`)
  const top = target.asset.replace(/\.tar\.bz2$/, '')
  const members = Object.keys(target.files).map((file) => `${top}/${file}`)
  const extract = spawnSync(tar, ['-xf', tarball, '-C', work, ...members], { encoding: 'utf8' })
  if (extract.status !== 0) throw new Error(`could not extract ${target.asset}: ${extract.stderr}`)

  fs.rmSync(dest, { recursive: true, force: true })
  for (const [file, folder] of Object.entries(target.files)) {
    const out = path.join(dest, folder, path.basename(file))
    fs.mkdirSync(path.dirname(out), { recursive: true })
    // Real files only: a symlink inside a signed app bundle breaks its signature.
    fs.copyFileSync(fs.realpathSync(path.join(work, top, file)), out)
    if (folder === 'bin' && !file.endsWith('.dll')) fs.chmodSync(out, 0o755)
  }
  for (const [name, licenseUrl] of Object.entries(LICENSES)) {
    fs.writeFileSync(path.join(dest, name), await download(licenseUrl))
  }
  console.log(`[sherpa] staged sherpa-onnx ${ref} (${target.key}) in ${dest}`)

  if (values.check) {
    const cli = path.join(dest, 'bin', path.basename(Object.keys(target.files)[0]))
    // With no arguments the CLI prints its usage. It only gets that far once ONNX Runtime loads.
    const run = spawnSync(cli, [], { encoding: 'utf8', cwd: path.dirname(cli) })
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
    if (!/Usage:/.test(output)) {
      throw new Error(
        `staged sherpa-onnx-offline did not start: ${run.error?.message ?? output.slice(-800)}`
      )
    }
    console.log('[sherpa] sherpa-onnx-offline starts and prints its usage')
  }
} catch (error) {
  console.error(`[sherpa] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
