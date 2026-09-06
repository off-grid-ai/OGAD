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

if (process.platform !== 'darwin') process.exit(0)

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
run(path.join(root, 'scripts', 'build-computer-use-capture.sh'), root)
run(path.join(root, 'pro', 'scripts', 'build-proximity-helper.sh'), path.join(root, 'pro'))
