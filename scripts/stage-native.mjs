#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') process.exit(0)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stageDir = path.join(root, 'resources', 'bin')
const moduleCache = path.join(process.env.TMPDIR || '/tmp', 'offgrid-swift-module-cache')
fs.mkdirSync(moduleCache, { recursive: true })

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
run(path.join(root, 'pro', 'scripts', 'build-proximity-helper.sh'), path.join(root, 'pro'))
