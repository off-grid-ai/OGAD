// Packaged-app regression smoke for the offline Pro license gate.
//
// A development build accepts OFFGRID_PRO=1 for local Pro work. A packaged build
// must ignore that override and require a real license. This runner launches an
// explicitly supplied packaged executable on a fresh profile and proves that the
// preload entitlement is false while the renderer still boots.
//
//   node scripts/smoke-license-gate.mjs \
//     "dist/mac-arm64/Off Grid AI Desktop.app/Contents/MacOS/Off Grid AI Desktop"
//
// APP_BIN may be used instead of the positional argument.
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node loads this smoke runner directly as JavaScript. */
import { _electron as electron } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import {
  constants,
  accessSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const CLOSE_TIMEOUT_MS = 10_000
const EXIT_TIMEOUT_MS = 2_000
const RENDER_TIMEOUT_MS = 30_000
let activeProfile

const delay = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })

function executableFromInput() {
  const input = process.argv[2] || process.env.APP_BIN
  if (!input) {
    throw new Error(
      'Usage: node scripts/smoke-license-gate.mjs <packaged-app-executable> (or set APP_BIN)'
    )
  }

  const executable = path.resolve(input)
  try {
    accessSync(executable, constants.X_OK)
    if (!statSync(executable).isFile()) throw new Error('not a file')
  } catch {
    throw new Error(`Packaged app executable is missing or not executable: ${executable}`)
  }
  return executable
}

function processTree(rootPid) {
  if (process.platform === 'win32') return [rootPid]

  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
  if (result.status !== 0) return [rootPid]

  const children = new Map()
  for (const line of result.stdout.split('\n')) {
    const [pidText, parentText] = line.trim().split(/\s+/)
    const pid = Number(pidText)
    const parent = Number(parentText)
    if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue
    const siblings = children.get(parent) || []
    siblings.push(pid)
    children.set(parent, siblings)
  }

  const descendants = []
  const visit = (parent) => {
    for (const child of children.get(parent) || []) {
      visit(child)
      descendants.push(child)
    }
  }
  visit(rootPid)
  return [...descendants, rootPid]
}

function signalProcesses(pids, signal) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      // The process already exited.
    }
  }
}

function removeActiveProfile() {
  if (!activeProfile) return
  rmSync(activeProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  activeProfile = undefined
}

async function closeApplication(app) {
  if (!app) return

  const child = app.process()
  const launchedProcesses = processTree(child.pid)
  const closed = await Promise.race([
    app.close().then(
      () => true,
      () => false
    ),
    delay(CLOSE_TIMEOUT_MS).then(() => false)
  ])

  const descendants = launchedProcesses.filter((pid) => pid !== child.pid)
  if (process.platform !== 'win32') {
    signalProcesses(descendants, 'SIGTERM')
    await delay(250)
    signalProcesses(descendants, 'SIGKILL')
  }

  if (!closed) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'])
    } else {
      signalProcesses([child.pid], 'SIGTERM')
      await delay(250)
      signalProcesses([child.pid], 'SIGKILL')
    }
  }
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      delay(EXIT_TIMEOUT_MS)
    ])
  }
  if (child.exitCode === null) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'])
    } else {
      signalProcesses([child.pid], 'SIGKILL')
    }
  }
}

async function run() {
  const executablePath = executableFromInput()
  const profileRoot = path.resolve(process.env.OFFGRID_LICENSE_SMOKE_PROFILE_ROOT || tmpdir())
  mkdirSync(profileRoot, { recursive: true })
  const profile = mkdtempSync(path.join(profileRoot, 'offgrid-license-gate-'))
  activeProfile = profile
  writeFileSync(
    path.join(profile, 'license.json'),
    JSON.stringify({
      enc: false,
      data: JSON.stringify({
        isPro: true,
        key: 'FORGED-PACKAGED-SMOKE-KEY',
        licenseId: 'forged-packaged-smoke-license',
        expiry: null,
        verifiedAt: Date.now()
      })
    }),
    { mode: 0o600 }
  )
  const environment = {
    ...process.env,
    OFFGRID_USER_DATA: profile,
    OFFGRID_PRO: '1'
  }
  delete environment.OFFGRID_SEED
  delete environment.OFFGRID_SEED_PRO
  // Inherited from a runner living inside Electron (VS Code tasks, the Electron-Node vitest
  // runner, agent sandboxes); it would turn the app under test into plain Node and the launch
  // would die before the gate can be observed.
  delete environment.ELECTRON_RUN_AS_NODE

  let app
  try {
    app = await electron.launch({
      executablePath,
      args: [],
      env: environment,
      timeout: RENDER_TIMEOUT_MS
    })
    const window = await app.firstWindow({ timeout: RENDER_TIMEOUT_MS })
    await window.waitForLoadState('domcontentloaded')
    await window.waitForFunction(
      () => {
        const root = document.querySelector('#root')
        const text = root?.textContent?.trim() || ''
        return Boolean(root && root.childElementCount > 0 && text.length > 0)
      },
      undefined,
      { timeout: RENDER_TIMEOUT_MS }
    )

    const result = await window.evaluate(() => {
      const root = document.querySelector('#root')
      return {
        isPro: window.api?.isPro,
        renderedRoot: Boolean(root?.childElementCount && root.textContent?.trim())
      }
    })

    if (result.isPro !== false) {
      throw new Error(
        `Packaged license gate failed: expected window.api.isPro to be false, received ${String(result.isPro)}`
      )
    }
    if (!result.renderedRoot) {
      throw new Error('Packaged license gate failed: renderer root is empty')
    }

    process.stdout.write('[license-smoke] packaged license gate passed\n')
  } finally {
    await closeApplication(app)
    removeActiveProfile()
  }
}

process.once('exit', removeActiveProfile)

try {
  await run()
  process.exit(0)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[license-smoke] ${message}`)
  process.exit(1)
}
