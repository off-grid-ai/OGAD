#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') process.exit(0)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildScript = path.join(root, 'pro', 'scripts', 'build-proximity-helper.sh')
if (!fs.existsSync(buildScript)) process.exit(0)

const stageDir = path.join(root, 'resources', 'bin')
const result = spawnSync('bash', [buildScript, stageDir], {
  cwd: path.join(root, 'pro'),
  stdio: 'inherit'
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
