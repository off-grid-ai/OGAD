#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stageDir = path.join(root, 'resources', 'bin')
const moduleCache = path.join(process.env.TMPDIR || '/tmp', 'offgrid-swift-module-cache')
fs.mkdirSync(moduleCache, { recursive: true })

/** @returns {boolean} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function electronCanLoadSqlite() {
  const require = createRequire(import.meta.url)
  const electronBinary = require('electron')
  const result = spawnSync(
    electronBinary,
    ['-e', 'new (require("better-sqlite3-multiple-ciphers"))(":memory:")'],
    {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    }
  )
  return result.status === 0
}

/** @returns {void} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function ensureElectronSqlite() {
  if (electronCanLoadSqlite()) return

  console.warn('[sqlite] Native module does not match Electron; rebuilding it now...')
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const result = spawnSync(
    npx,
    ['electron-rebuild', '-f', '-w', 'better-sqlite3-multiple-ciphers'],
    { cwd: root, stdio: 'inherit' }
  )
  if (result.error) throw result.error
  if (result.status !== 0 || !electronCanLoadSqlite()) {
    console.error('[sqlite] Could not restore the Electron native module.')
    process.exit(result.status || 1)
  }
  console.log('[sqlite] Electron native module restored.')
}

ensureElectronSqlite()

/**
 * Pro's speaker-diarize helper ships on every platform: macOS and Windows package resources/bin,
 * Linux packages build/linux-bin.
 * @returns {void}
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function stageSpeakerDiarize() {
  const script = path.join(root, 'pro', 'scripts', 'build-speaker-diarize.mjs')
  if (!fs.existsSync(script)) return
  const target = process.platform === 'linux' ? path.join(root, 'build', 'linux-bin') : stageDir
  const result = spawnSync(process.execPath, [script, target], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

stageSpeakerDiarize()

/**
 * Pro's Scribe overlay: Windows builds scribe-overlay-win.exe into resources/bin; Linux stages the
 * X11 helper into build/linux-bin. macOS builds it below with the other Swift helpers.
 * @returns {void}
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function stageScribeOverlay() {
  const scripts = path.join(root, 'pro', 'scripts')
  if (process.platform === 'win32') {
    const script = path.join(scripts, 'build-scribe-overlay-win.ps1')
    if (!fs.existsSync(script)) return
    const result = spawnSync('pwsh', ['-NoProfile', '-File', script, '-StageDir', stageDir], {
      cwd: root,
      stdio: 'inherit'
    })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
  } else if (process.platform === 'linux') {
    const script = path.join(scripts, 'build-scribe-overlay-linux.sh')
    if (!fs.existsSync(script)) return
    const result = spawnSync('bash', [script, path.join(root, 'build', 'linux-bin')], {
      cwd: root,
      stdio: 'inherit'
    })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}

stageScribeOverlay()

if (process.platform !== 'darwin') process.exit(0)

/**
 * @param {string} script
 * @param {string} cwd
 * @returns {void}
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function run(script, cwd) {
  if (!fs.existsSync(script)) return
  const result = spawnSync('bash', [script, stageDir], {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      CLANG_MODULE_CACHE_PATH: moduleCache,
      SWIFT_MODULECACHE_PATH: moduleCache
    }
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(path.join(root, 'scripts', 'build-keychain-bootstrap.sh'), root)
run(path.join(root, 'scripts', 'build-location.sh'), root)
run(path.join(root, 'scripts', 'build-computer-use-capture.sh'), root)
run(path.join(root, 'scripts', 'build-ocr.sh'), root)
run(path.join(root, 'scripts', 'build-actions-helper.sh'), root)
run(path.join(root, 'pro', 'scripts', 'build-proximity-helper.sh'), path.join(root, 'pro'))
run(path.join(root, 'pro', 'scripts', 'build-scribe-overlay.sh'), path.join(root, 'pro'))

// c2patool signs the AI label into exported videos, on every platform that has a build.
{
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'fetch-c2patool.mjs')], {
    cwd: root,
    stdio: 'inherit'
  })
  if (result.status !== 0) {
    // A release build must carry it; a local build can go on with the metadata label only.
    if (process.env.CI) process.exit(result.status ?? 1)
    console.warn('[c2patool] not staged; exports keep the metadata label only')
  }
}
