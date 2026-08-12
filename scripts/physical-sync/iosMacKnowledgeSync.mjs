#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node executes this physical-device harness directly as JavaScript. */

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, '../..')
const mobileRoot = process.env.OFFGRID_MOBILE_ROOT ?? path.resolve(repoRoot, '../mobile')
const mobileAdapter = path.join(mobileRoot, 'scripts/physical-sync/iosKnowledgeSyncAdapter.mjs')
const desktopAdapter = path.join(repoRoot, 'scripts/physical-sync/desktopKnowledgeSyncAdapter.mjs')
const execute = process.argv.includes('--execute')
const skipBuild = process.argv.includes('--skip-build')
const projectName = process.env.SYNC_PROJECT_NAME
const mobileFixturePath = process.env.IOS_SYNC_FIXTURE_PATH
const mobileFixtureName = mobileFixturePath ? path.basename(mobileFixturePath) : undefined
const peerName = process.env.IOS_SYNC_PEER_NAME ?? "Mac's iPhone"
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const artifactDir =
  process.env.SYNC_PHYSICAL_ARTIFACT_DIR ??
  path.join(os.tmpdir(), `offgrid-ios-macos-sync-${runId}`)
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-desktop-sync-fixture-'))
const desktopFixturePath = path.join(fixtureDir, `desktop-${runId}.txt`)
const desktopFixtureName = path.basename(desktopFixturePath)

if (process.argv.includes('--help')) {
  process.stdout.write(`Physical iOS <-> macOS knowledge Sync

Required environment:
  SYNC_PROJECT_NAME          Existing project visible on both devices
  IOS_SYNC_FIXTURE_PATH      Synthetic Mac file also staged in Apple Files
  IOS_SYNC_WDA_URL           Current URL printed by mobile's scripts/ios/launch-wda.mjs
  IOS_DEVICE_ID              Physical iPhone hardware UDID

Optional:
  IOS_SYNC_PEER_NAME         iPhone name shown on Desktop (default: Mac's iPhone)
  SYNC_PHYSICAL_ARTIFACT_DIR Local evidence directory

Commands:
  npm run test:sync:physical
  npm run test:sync:physical -- --execute
  npm run test:sync:physical -- --execute --skip-build
`)
  process.exit(0)
}

class JsonlClient {
  constructor(label, command, args, options) {
    this.label = label
    this.pending = new Map()
    this.sequence = 0
    this.process = spawn(command, args, {
      ...options,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const output = readline.createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity
    })
    output.on('line', (line) => {
      let response
      try {
        response = JSON.parse(line)
      } catch {
        this.failAll(new Error(`${this.label} emitted non-JSON output: ${line}`))
        return
      }
      const pending = this.pending.get(response.id)
      if (!pending) return
      this.pending.delete(response.id)
      clearTimeout(pending.timer)
      if (response.status === 'ok') pending.resolve(response)
      else {
        const message =
          typeof response.error === 'string'
            ? response.error
            : (response.error?.message ?? JSON.stringify(response.error))
        pending.reject(new Error(`${this.label} ${response.action}: ${message}`))
      }
    })
    this.process.stderr.on('data', (chunk) => {
      process.stderr.write(`[${this.label}] ${chunk}`)
    })
    this.process.once('exit', (code, signal) => {
      this.failAll(
        new Error(
          `${this.label} adapter exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`
        )
      )
    })
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  request(action, args = {}, timeoutMs = 180_000) {
    const id = `${this.label}-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.label} ${action} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.process.stdin.write(`${JSON.stringify({ id, action, args })}\n`)
    })
  }

  async stop() {
    if (this.process.exitCode !== null) return
    this.process.stdin.end()
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.process.kill('SIGTERM')
        resolve()
      }, 10_000)
      this.process.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

const startAdapters = () => {
  const sharedEnv = {
    ...process.env,
    DESKTOP_SYNC_ARTIFACT_DIR: artifactDir,
    IOS_SYNC_ARTIFACT_DIR: artifactDir
  }
  return {
    desktop: new JsonlClient('desktop', process.execPath, [desktopAdapter, 'serve'], {
      cwd: repoRoot,
      env: sharedEnv
    }),
    mobile: new JsonlClient(
      'mobile',
      process.execPath,
      ['--experimental-strip-types', mobileAdapter, 'serve'],
      {
        cwd: mobileRoot,
        env: sharedEnv
      }
    )
  }
}

const stopAdapters = async (adapters) => {
  await Promise.allSettled([adapters.desktop.stop(), adapters.mobile.stop()])
}

const requireInputs = () => {
  const missing = []
  if (!projectName) missing.push('SYNC_PROJECT_NAME')
  if (!mobileFixturePath) missing.push('IOS_SYNC_FIXTURE_PATH')
  if (mobileFixturePath && !fs.existsSync(mobileFixturePath)) {
    missing.push(`iOS fixture at ${mobileFixturePath}`)
  }
  if (!process.env.IOS_SYNC_WDA_URL) missing.push('IOS_SYNC_WDA_URL')
  if (!process.env.IOS_DEVICE_ID) missing.push('IOS_DEVICE_ID')
  if (!fs.existsSync(mobileAdapter)) {
    missing.push(`Mobile adapter at ${mobileAdapter}`)
  }
  if (missing.length > 0) {
    throw new Error(`missing physical-test prerequisites: ${missing.join(', ')}`)
  }
}

const writeDesktopFixture = () => {
  fs.writeFileSync(
    desktopFixturePath,
    [
      `Off Grid physical Sync fixture ${runId}.`,
      'This synthetic document was created on macOS and must arrive on iOS through encrypted Sync.',
      'It contains no private user data.'
    ].join('\n')
  )
}

const buildDesktop = async () => {
  process.stdout.write('[physical-sync] building the current Desktop Pro app\n')
  await new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'build:unpack'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CSC_IDENTITY_AUTO_DISCOVERY: 'false'
      },
      stdio: 'inherit'
    })
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Desktop build exited with code ${code}`))
    })
  })
}

const screenshotBoth = async (adapters, name) => {
  await Promise.allSettled([
    adapters.desktop.request('screenshot', { name: `${name}-desktop` }, 30_000),
    adapters.mobile.request(
      'screenshot',
      { path: path.join(artifactDir, `${name}-ios.png`) },
      30_000
    )
  ])
}

const preflight = async (adapters) => {
  const [desktop, mobile] = await Promise.all([
    adapters.desktop.request('preflight', {}, 30_000),
    adapters.mobile.request('preflight', {}, 30_000)
  ])
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: 'ready',
        execute,
        projectName,
        desktopFixtureName,
        mobileFixtureName,
        artifactDir,
        desktop: desktop.observed,
        mobile: mobile.observed
      },
      null,
      2
    )}\n`
  )
}

const runJourney = async (adapters) => {
  const documentTimeout = 120_000
  await Promise.all([
    adapters.desktop.request('launch', { peerName, timeoutMs: 60_000 }, 90_000),
    adapters.mobile.request('launch', { restart: false }, 90_000)
  ])

  await adapters.desktop.request(
    'add-fixture',
    {
      project: projectName,
      path: desktopFixturePath,
      timeoutMs: documentTimeout
    },
    150_000
  )
  await adapters.mobile.request(
    'wait-document',
    {
      project: projectName,
      name: desktopFixtureName,
      present: true,
      enabled: true,
      timeoutMs: documentTimeout
    },
    150_000
  )

  await adapters.mobile.request(
    'add-fixture',
    {
      project: projectName,
      fixture: mobileFixturePath,
      timeoutMs: documentTimeout
    },
    150_000
  )
  await adapters.desktop.request(
    'wait-document',
    {
      project: projectName,
      name: mobileFixtureName,
      present: true,
      enabled: true,
      timeoutMs: documentTimeout
    },
    150_000
  )
  await screenshotBoth(adapters, 'both-directions')

  await adapters.desktop.request(
    'toggle-document',
    {
      project: projectName,
      name: mobileFixtureName,
      enabled: false,
      timeoutMs: documentTimeout
    },
    150_000
  )
  await adapters.mobile.request(
    'wait-document',
    {
      project: projectName,
      name: mobileFixtureName,
      present: true,
      enabled: false,
      timeoutMs: documentTimeout
    },
    150_000
  )
  await adapters.mobile.request(
    'toggle-document',
    {
      project: projectName,
      name: mobileFixtureName,
      enabled: true,
      timeoutMs: documentTimeout
    },
    150_000
  )
  await adapters.desktop.request(
    'wait-document',
    {
      project: projectName,
      name: mobileFixtureName,
      present: true,
      enabled: true,
      timeoutMs: documentTimeout
    },
    150_000
  )

  await adapters.mobile.request(
    'delete-document',
    {
      project: projectName,
      name: desktopFixtureName,
      timeoutMs: documentTimeout
    },
    150_000
  )
  await adapters.desktop.request(
    'wait-document',
    {
      project: projectName,
      name: desktopFixtureName,
      present: false,
      timeoutMs: documentTimeout
    },
    150_000
  )
}

const verifyRelaunchAndCleanup = async (adapters) => {
  const documentTimeout = 120_000
  await Promise.all([
    adapters.desktop.request('launch', { peerName, timeoutMs: 60_000 }, 90_000),
    adapters.mobile.request('launch', { restart: true }, 90_000)
  ])
  await Promise.all([
    adapters.desktop.request(
      'wait-document',
      {
        project: projectName,
        name: mobileFixtureName,
        present: true,
        enabled: true,
        timeoutMs: documentTimeout
      },
      150_000
    ),
    adapters.mobile.request(
      'wait-document',
      {
        project: projectName,
        name: mobileFixtureName,
        present: true,
        enabled: true,
        timeoutMs: documentTimeout
      },
      150_000
    )
  ])
  await screenshotBoth(adapters, 'after-relaunch')
  await adapters.desktop.request(
    'delete-document',
    {
      project: projectName,
      name: mobileFixtureName,
      timeoutMs: documentTimeout
    },
    150_000
  )
  await adapters.mobile.request(
    'wait-document',
    {
      project: projectName,
      name: mobileFixtureName,
      present: false,
      timeoutMs: documentTimeout
    },
    150_000
  )
  await screenshotBoth(adapters, 'cleanup-converged')
}

const leaveDesktopOpen = async () => {
  const app =
    process.env.DESKTOP_SYNC_APP_PATH ??
    path.join(repoRoot, 'dist/mac-arm64/Off Grid AI Desktop.app')
  await execFileAsync('open', [app]).catch(() => undefined)
}

let adapters
try {
  requireInputs()
  fs.mkdirSync(artifactDir, { recursive: true })
  writeDesktopFixture()
  if (execute && !skipBuild) await buildDesktop()
  adapters = startAdapters()
  await preflight(adapters)
  if (!execute) {
    process.stdout.write(
      '[physical-sync] preflight only. Re-run with --execute to build, restart, and test both devices.\n'
    )
  } else {
    await runJourney(adapters)
    await stopAdapters(adapters)
    adapters = startAdapters()
    await verifyRelaunchAndCleanup(adapters)
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        status: 'passed',
        projectName,
        artifactDir
      })}\n`
    )
  }
} catch (error) {
  if (adapters) await screenshotBoth(adapters, 'failure')
  process.stderr.write(
    `[physical-sync] FAILED: ${error instanceof Error ? error.message : String(error)}\n`
  )
  process.exitCode = 1
} finally {
  if (adapters) await stopAdapters(adapters)
  fs.rmSync(fixtureDir, { recursive: true, force: true })
  if (execute) await leaveDesktopOpen()
}
