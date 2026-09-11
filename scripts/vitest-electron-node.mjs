import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const require = createRequire(import.meta.url)
const electronBinary = require('electron')
const vitestCli = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))

/**
 * Every desktop test entrypoint runs through this launcher, and every one of them imports
 * `@offgrid/*` from the `file:` dependency's `dist/`. A stale or out-of-order Shared build
 * therefore fails - or worse, silently passes - against declarations that do not describe the
 * runtime the app will load. Run the one canonical gate here, as a subprocess of the script
 * that owns it, so no test command can start on unverified artifacts and no second copy of the
 * contract exists.
 */
const contractGate = fileURLToPath(
  new URL('./verify-shared-consumer-contract.mjs', import.meta.url)
)
const gate = spawnSync(process.execPath, [contractGate], { cwd: process.cwd(), stdio: 'inherit' })
if (gate.error) {
  console.error(`[vitest-electron-node] ${gate.error.message}`)
  process.exit(1)
}
if (gate.status !== 0) process.exit(gate.status ?? 1)

const child = spawn(electronBinary, [vitestCli, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1'
  },
  stdio: 'inherit'
})

child.on('error', (error) => {
  console.error(`[vitest-electron-node] ${error.message}`)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exitCode = code ?? 1
})
