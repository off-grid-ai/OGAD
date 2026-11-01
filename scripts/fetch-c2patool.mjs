#!/usr/bin/env node
// Stages the pinned c2patool (Content Authenticity Initiative, MIT/Apache-2.0) into resources/bin,
// like ffmpeg. The app signs a C2PA "made with AI" claim into every exported video with it.
//   node scripts/fetch-c2patool.mjs [--platform darwin|win32|linux] [--bin <dir>]
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '0.27.22'
const ASSETS = {
  darwin: {
    file: `c2patool-v${VERSION}-universal-apple-darwin.zip`,
    sha256: 'd064ca72e599c74e5fdc2ed04b47d6cb62210a2b14db589d078c2ec27c98d3df'
  },
  win32: {
    file: `c2patool-v${VERSION}-x86_64-pc-windows-msvc.zip`,
    sha256: '2e6808719b5610f9ab096857f600f16938fda3c7388de3829f0dea1c2a345011'
  },
  linux: {
    file: `c2patool-v${VERSION}-x86_64-unknown-linux-gnu.tar.gz`,
    sha256: '6f138ad53da1a62f1cd6ee71c60727efa27d13b811f4c0ea8c2a8528968b358b'
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const flag = process.argv.indexOf('--platform')
const platform = flag > 0 ? process.argv[flag + 1] : process.platform
const asset = ASSETS[platform]
if (!asset) {
  console.log(`[c2patool] no build for ${platform}; exports keep the metadata label only`)
  process.exit(0)
}
const binFlag = process.argv.indexOf('--bin')
// Where the installer takes binaries from: resources/bin, or build/linux-bin on Linux.
const bin = binFlag > 0 ? path.resolve(process.argv[binFlag + 1]) : path.join(root, 'resources', 'bin')
const target = path.join(bin, platform === 'win32' ? 'c2patool.exe' : 'c2patool')
const stamp = `${target}.version`
if (fs.existsSync(target) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === `${VERSION} ${platform}`) {
  process.exit(0)
}

const url = `https://github.com/contentauth/c2pa-rs/releases/download/c2patool-v${VERSION}/${asset.file}`
const response = await fetch(url)
if (!response.ok) throw new Error(`[c2patool] download failed: ${response.status} ${url}`)
const bytes = Buffer.from(await response.arrayBuffer())
const digest = createHash('sha256').update(bytes).digest('hex')
if (digest !== asset.sha256) throw new Error(`[c2patool] checksum mismatch for ${asset.file}`)

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'c2patool-'))
try {
  const archive = path.join(work, asset.file)
  fs.writeFileSync(archive, bytes)
  // bsdtar (macOS, Windows 10+) and GNU tar both read these archives.
  const result = spawnSync('tar', ['-xf', archive, '-C', work], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('[c2patool] could not unpack the archive')
  const name = platform === 'win32' ? 'c2patool.exe' : 'c2patool'
  const found = fs
    .readdirSync(work, { recursive: true })
    .map((entry) => path.join(work, String(entry)))
    .find((entry) => path.basename(entry) === name && fs.statSync(entry).isFile())
  if (!found) throw new Error('[c2patool] binary not found in the archive')
  fs.mkdirSync(path.join(bin, 'licenses'), { recursive: true })
  fs.copyFileSync(found, target)
  fs.chmodSync(target, 0o755)
  fs.writeFileSync(
    path.join(bin, 'licenses', 'c2patool.txt'),
    `c2patool ${VERSION} (https://github.com/contentauth/c2pa-rs)\nLicensed under MIT or Apache-2.0.\n`
  )
  fs.writeFileSync(stamp, `${VERSION} ${platform}\n`)
  console.log(`[c2patool] staged ${VERSION} for ${platform}`)
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
