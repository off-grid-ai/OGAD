/* eslint-disable @typescript-eslint/explicit-function-return-type -- This module executes directly in Node; public return types live in the companion .d.mts. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { listPackage } from '@electron/asar'
import { verifyReleaseAppTrust, verifyStrictAppTrust } from './macos-app-trust.mjs'

const rawExecFileAsync = promisify(execFile)
const execFileAsync = (executable, args) =>
  rawExecFileAsync(executable, args, { timeout: 120_000, killSignal: 'SIGKILL' })

export const REQUIRED_MAC_BUNDLE_FILES = Object.freeze([
  'Contents/Info.plist',
  'Contents/MacOS/Off Grid AI Desktop',
  'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
  'Contents/Resources/app.asar',
  'Contents/Resources/bin/llama/llama-server',
  'Contents/Resources/bin/meeting-recorder',
  'Contents/Resources/bin/computer-use-capture',
  'Contents/Resources/bin/dictation-hotkey'
])

export const REQUIRED_EXECUTABLE_FILES = new Set([
  'Contents/MacOS/Off Grid AI Desktop',
  'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
  'Contents/Resources/bin/llama/llama-server',
  'Contents/Resources/bin/meeting-recorder',
  'Contents/Resources/bin/computer-use-capture',
  'Contents/Resources/bin/dictation-hotkey'
])

const FORBIDDEN_PRIVATE_SEGMENTS = new Set(['.demo-profile', '.offgrid', '.claude', '.codex'])

export const ALLOWED_ASAR_ROOTS = Object.freeze(['/node_modules', '/out', '/package.json'])

export const ALLOWED_ASAR_OUT_ROOTS = Object.freeze(['/out/main', '/out/preload', '/out/renderer'])

function normalizeRelative(relative) {
  return relative.split(path.sep).join('/')
}

function fileDigest(file) {
  const hash = createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)

  try {
    let bytesRead
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead))
      }
    } while (bytesRead > 0)
  } finally {
    fs.closeSync(descriptor)
  }

  return hash.digest('hex')
}

function entryKind(stat) {
  if (stat.isFile()) return 'file'
  if (stat.isDirectory()) return 'directory'
  if (stat.isSymbolicLink()) return 'symlink'
  return 'other'
}

function bundleManifest(bundle) {
  const manifest = new Map()

  function visit(directory, relativeDirectory = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = normalizeRelative(path.join(relativeDirectory, entry.name))
      const absolute = path.join(directory, entry.name)
      const stat = fs.lstatSync(absolute)
      const kind = entryKind(stat)

      manifest.set(relative, {
        kind,
        size: kind === 'file' ? stat.size : undefined,
        target: kind === 'symlink' ? fs.readlinkSync(absolute) : undefined
      })

      if (kind === 'directory') {
        visit(absolute, relative)
      }
    }
  }

  visit(bundle)
  return manifest
}

function assertBundleRoot(bundle, label) {
  if (!fs.existsSync(bundle) || !fs.statSync(bundle).isDirectory()) {
    throw new Error(`${label} bundle is not a directory: ${bundle}`)
  }
}

function assertRequiredFiles(bundle, label) {
  for (const relative of REQUIRED_MAC_BUNDLE_FILES) {
    const file = path.join(bundle, relative)
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`${label} bundle is missing required file: ${relative}`)
    }
    if (REQUIRED_EXECUTABLE_FILES.has(relative) && (fs.statSync(file).mode & 0o111) === 0) {
      throw new Error(`${label} bundle required file is not executable: ${relative}`)
    }
  }
}

function assertNoPrivateState(manifest, label) {
  for (const relative of manifest.keys()) {
    const privateSegment = relative
      .split('/')
      .find((segment) => FORBIDDEN_PRIVATE_SEGMENTS.has(segment.toLowerCase()))
    if (privateSegment) {
      throw new Error(`${label} bundle contains forbidden private state: ${relative}`)
    }
  }
}

function compareManifests(reference, candidate) {
  const missing = [...reference.keys()].filter((relative) => !candidate.has(relative))
  const extra = [...candidate.keys()].filter((relative) => !reference.has(relative))
  const changed = [...reference.entries()]
    .filter(([relative, expected]) => {
      const actual = candidate.get(relative)
      return (
        actual &&
        (actual.kind !== expected.kind ||
          actual.size !== expected.size ||
          actual.target !== expected.target)
      )
    })
    .map(([relative]) => relative)

  if (missing.length || extra.length || changed.length) {
    const details = [
      ...missing.map((relative) => `missing: ${relative}`),
      ...extra.map((relative) => `extra: ${relative}`),
      ...changed.map((relative) => `changed: ${relative}`)
    ]
    throw new Error(`candidate bundle differs from packaged bundle:\n${details.join('\n')}`)
  }
}

function compareRequiredDigests(referenceBundle, candidateBundle) {
  for (const relative of REQUIRED_MAC_BUNDLE_FILES) {
    const referenceDigest = fileDigest(path.join(referenceBundle, relative))
    const candidateDigest = fileDigest(path.join(candidateBundle, relative))
    if (referenceDigest !== candidateDigest) {
      throw new Error(`candidate bundle required file content differs: ${relative}`)
    }
  }
}

export function verifyBundlePair(referenceBundle, candidateBundle) {
  assertBundleRoot(referenceBundle, 'packaged')
  assertBundleRoot(candidateBundle, 'candidate')
  assertRequiredFiles(referenceBundle, 'packaged')
  assertRequiredFiles(candidateBundle, 'candidate')

  const referenceManifest = bundleManifest(referenceBundle)
  const candidateManifest = bundleManifest(candidateBundle)
  assertNoPrivateState(referenceManifest, 'packaged')
  assertNoPrivateState(candidateManifest, 'candidate')
  compareManifests(referenceManifest, candidateManifest)
  compareRequiredDigests(referenceBundle, candidateBundle)
}

function isAllowedAsarOutEntry(entry) {
  return ALLOWED_ASAR_OUT_ROOTS.some((root) => entry === root || entry.startsWith(`${root}/`))
}

// Pure inventory check over an asar's entry list, split out so it unit-tests without
// building a real archive. @electron/asar's listPackage returns entries with the OS
// path separator — POSIX "/" on macOS/Linux but "\" on Windows (e.g. "\node_modules").
// Normalize to "/" so the POSIX allowlist below holds on every build host; without it
// EVERY entry read as an unexpected root on the Windows runner and this release gate
// rejected an otherwise-valid app.asar (regressing the Windows build).
export function assertAsarEntryInventory(entries) {
  for (const rawEntry of entries) {
    const entry = rawEntry.replace(/\\/g, '/')
    const segments = entry.split('/').filter(Boolean)
    const privateSegment = segments.find((segment) =>
      FORBIDDEN_PRIVATE_SEGMENTS.has(segment.toLowerCase())
    )
    if (privateSegment) {
      throw new Error(`app.asar contains forbidden private state: ${entry}`)
    }
    if (segments.some((segment) => segment.toLowerCase().endsWith('.app'))) {
      throw new Error(`app.asar contains a nested application bundle: ${entry}`)
    }

    if (entry === '/out' || isAllowedAsarOutEntry(entry)) continue
    if (entry.startsWith('/out/')) {
      throw new Error(`app.asar contains unexpected build output: ${entry}`)
    }
    if (!ALLOWED_ASAR_ROOTS.some((root) => entry === root || entry.startsWith(`${root}/`))) {
      throw new Error(`app.asar contains unexpected application root: ${entry}`)
    }
  }
}

export function assertAsarArchiveInventory(archive) {
  assertAsarEntryInventory(listPackage(archive))
}

export function assertAsarInventory(bundle) {
  assertAsarArchiveInventory(path.join(bundle, 'Contents/Resources/app.asar'))
}

function findSingleApp(mountPoint) {
  const apps = fs
    .readdirSync(mountPoint, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    .map((entry) => path.join(mountPoint, entry.name))

  if (apps.length !== 1) {
    throw new Error(`expected exactly one app bundle in DMG, found ${apps.length}`)
  }
  return apps[0]
}

async function verifyDmgArtifactWithTrust(dmgPath, referenceBundle, releaseTeamId) {
  if (process.platform !== 'darwin') {
    throw new Error('DMG integrity verification requires macOS')
  }
  if (!fs.existsSync(dmgPath) || !fs.statSync(dmgPath).isFile()) {
    throw new Error(`DMG artifact does not exist: ${dmgPath}`)
  }

  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-dmg-integrity-'))
  const mountPoint = path.join(workRoot, 'mount')
  fs.mkdirSync(mountPoint)
  let attachAttempted = false
  let operationError

  try {
    attachAttempted = true
    await execFileAsync('/usr/bin/hdiutil', [
      'attach',
      dmgPath,
      '-readonly',
      '-nobrowse',
      '-mountpoint',
      mountPoint
    ])
    const candidateBundle = findSingleApp(mountPoint)
    verifyBundlePair(referenceBundle, candidateBundle)
    assertAsarInventory(referenceBundle)
    assertAsarInventory(candidateBundle)
    if (releaseTeamId) {
      await verifyReleaseAppTrust(referenceBundle, releaseTeamId)
      await verifyReleaseAppTrust(candidateBundle, releaseTeamId)
    } else {
      await verifyStrictAppTrust(referenceBundle)
      await verifyStrictAppTrust(candidateBundle)
    }
  } catch (error) {
    operationError = error
  }

  let cleanupError
  if (attachAttempted) {
    try {
      await execFileAsync('/usr/bin/hdiutil', ['detach', mountPoint, '-force'])
    } catch (error) {
      cleanupError = error
    }
  }
  if (!cleanupError) {
    fs.rmSync(workRoot, { recursive: true, force: true })
  }
  if (operationError) {
    if (cleanupError && typeof operationError === 'object') {
      operationError.cause = cleanupError
    }
    throw operationError
  }
  if (cleanupError) throw cleanupError
}

async function verifyZipArtifactWithTrust(zipPath, referenceBundle, releaseTeamId) {
  if (process.platform !== 'darwin') {
    throw new Error('macOS ZIP integrity verification requires macOS')
  }
  if (!fs.existsSync(zipPath) || !fs.statSync(zipPath).isFile()) {
    throw new Error(`ZIP artifact does not exist: ${zipPath}`)
  }

  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-zip-integrity-'))
  try {
    await execFileAsync('/usr/bin/ditto', ['-x', '-k', zipPath, workRoot])
    const candidateBundle = findSingleApp(workRoot)
    verifyBundlePair(referenceBundle, candidateBundle)
    assertAsarInventory(referenceBundle)
    assertAsarInventory(candidateBundle)
    if (releaseTeamId) {
      await verifyReleaseAppTrust(referenceBundle, releaseTeamId)
      await verifyReleaseAppTrust(candidateBundle, releaseTeamId)
    } else {
      await verifyStrictAppTrust(referenceBundle)
      await verifyStrictAppTrust(candidateBundle)
    }
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true })
  }
}

export async function verifyDmgArtifact(dmgPath, referenceBundle) {
  await verifyDmgArtifactWithTrust(dmgPath, referenceBundle, null)
}

export async function verifyReleaseDmgArtifact(dmgPath, referenceBundle, expectedTeamId) {
  if (!expectedTeamId.trim()) {
    throw new Error('Expected Apple team identifier must not be empty')
  }
  await verifyDmgArtifactWithTrust(dmgPath, referenceBundle, expectedTeamId)
}

export async function verifyZipArtifact(zipPath, referenceBundle) {
  await verifyZipArtifactWithTrust(zipPath, referenceBundle, null)
}

export async function verifyReleaseZipArtifact(zipPath, referenceBundle, expectedTeamId) {
  if (!expectedTeamId.trim()) {
    throw new Error('Expected Apple team identifier must not be empty')
  }
  await verifyZipArtifactWithTrust(zipPath, referenceBundle, expectedTeamId)
}
