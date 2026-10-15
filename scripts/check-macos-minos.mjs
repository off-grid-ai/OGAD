#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [maximum = '13.0', ...requestedRoots] = process.argv.slice(2)
if (!/^\d+(?:\.\d+){0,2}$/.test(maximum)) throw new Error('Expected a macOS version, e.g. 13.0')
const folderOverrides = new Map([
  // Core ML image generation uses macOS 14 Core ML APIs.
  ['coreml-sd', '14.0'],
  // The Kev MLX runtime needs macOS 14; the app hides Kev on older macOS.
  ['kev-runtime', '14.0']
])
const roots = requestedRoots.length
  ? requestedRoots.map((root) => path.resolve(root))
  : [
      path.join(repo, 'resources/bin'),
      ...[path.resolve(repo, '../executorch-speech/native/bin')].filter((root) =>
        fs.existsSync(root)
      )
    ]
const magicNumbers = new Set([
  'feedface',
  'cefaedfe',
  'feedfacf',
  'cffaedfe',
  'cafebabe',
  'bebafeca',
  'cafebabf',
  'bfbafeca'
])
const visited = new Set()
const failures = []
let checked = 0
function exceeds(version, target) {
  const actual = version.split('.').map(Number)
  const allowed = target.split('.').map(Number)
  for (let i = 0; i < Math.max(actual.length, allowed.length); i++) {
    if ((actual[i] ?? 0) !== (allowed[i] ?? 0)) return (actual[i] ?? 0) > (allowed[i] ?? 0)
  }
  return false
}
function walk(file, root) {
  const real = fs.realpathSync(file)
  if (visited.has(real)) return
  visited.add(real)
  const stat = fs.statSync(file)
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(file)) walk(path.join(file, name), root)
    return
  }
  if (!stat.isFile()) return
  const header = Buffer.alloc(4)
  const fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, header, 0, 4, 0)
  } finally {
    fs.closeSync(fd)
  }
  if (!magicNumbers.has(header.toString('hex'))) return
  checked++
  const folder = path.relative(root, file).split(path.sep)[0]
  const limit = folderOverrides.get(folder) ?? maximum
  try {
    // Inspect all universal slices, including legacy LC_VERSION_MIN_MACOSX commands.
    const output = execFileSync('otool', ['-arch', 'all', '-l', file], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    })
    const versions = [
      ...output.matchAll(
        /cmd LC_BUILD_VERSION\s[\s\S]*?\bminos\s+(\d+(?:\.\d+)*)|cmd LC_VERSION_MIN_MACOSX\s[\s\S]*?\bversion\s+(\d+(?:\.\d+)*)/g
      )
    ].map((match) => match[1] ?? match[2])
    if (!versions.length) failures.push(`${file}: no macOS minimum version found`)
    for (const version of new Set(versions)) {
      if (exceeds(version, limit)) failures.push(`${file}: minos ${version} exceeds ${limit}`)
    }
  } catch (error) {
    failures.push(`${file}: cannot inspect Mach-O (${error.message})`)
  }
}
for (const root of roots) walk(root, root)
if (!checked) failures.push('No Mach-O files found')
if (failures.length) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else {
  console.log(`[macos-minos] checked ${checked} Mach-O files (default maximum ${maximum})`)
}
