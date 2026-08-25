import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const RUNNER = path.join(REPO_ROOT, 'scripts', 'smoke-license-gate.mjs')
const ELECTRON_EXECUTABLE = path.join(
  REPO_ROOT,
  'node_modules',
  'electron',
  'dist',
  'Electron.app',
  'Contents',
  'MacOS',
  'Electron'
)
const REAL_APP_TIMEOUT_MS = 60_000
const tempRoots: string[] = []

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-license-smoke-test-'))
  tempRoots.push(root)
  return root
}

function runRunner(
  executable?: string,
  extraEnvironment: NodeJS.ProcessEnv = {}
): SpawnSyncReturns<string> {
  const args = executable ? [RUNNER, executable] : [RUNNER]
  return spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // A runner living inside Electron (VS Code tasks, agent sandboxes) exports
    // ELECTRON_RUN_AS_NODE=1; inherited, it turns the Electron under test into
    // plain Node and the launch dies before the gate can be observed.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ...extraEnvironment },
    timeout: REAL_APP_TIMEOUT_MS
  })
}

function suppliedPackagedExecutable(): string | undefined {
  return process.env.OFFGRID_LICENSE_SMOKE_APP_BIN
    ? path.resolve(process.env.OFFGRID_LICENSE_SMOKE_APP_BIN)
    : undefined
}

afterEach(() => {
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

describe.sequential('packaged license gate smoke', () => {
  it('fails loudly when no packaged executable is supplied', () => {
    const result = runRunner(undefined, { APP_BIN: '' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Usage: node scripts/smoke-license-gate.mjs')
  })

  it.skipIf(process.platform !== 'darwin')(
    'passes a fresh forced-Pro profile to Playwright and removes it after assertion failure',
    () => {
      const root = tempRoot()
      const capture = path.join(root, 'environment.json')
      const fixture = path.join(root, 'electron-fixture')
      const executable = path.join(root, 'electron-fixture-executable')
      fs.mkdirSync(fixture)
      fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ main: 'main.js' }))
      fs.writeFileSync(
        path.join(fixture, 'main.js'),
        `const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.whenReady().then(async () => {
  fs.writeFileSync(process.env.OFFGRID_LICENSE_SMOKE_CAPTURE, JSON.stringify({
    profile: process.env.OFFGRID_USER_DATA,
    pro: process.env.OFFGRID_PRO
  }))
  const window = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  })
  await window.loadFile(path.join(__dirname, 'index.html'))
})

app.on('window-all-closed', () => app.quit())
`
      )
      fs.writeFileSync(
        path.join(fixture, 'preload.js'),
        `const { contextBridge } = require('electron')
contextBridge.exposeInMainWorld('api', { isPro: true })
`
      )
      fs.writeFileSync(
        path.join(fixture, 'index.html'),
        '<!doctype html><html><body><div id="root"><main>fixture renderer</main></div></body></html>\n'
      )
      fs.writeFileSync(
        executable,
        `#!/usr/bin/env bash
exec ${JSON.stringify(ELECTRON_EXECUTABLE)} "$@" ${JSON.stringify(fixture)}
`,
        { mode: 0o755 }
      )

      const result = runRunner(executable, {
        OFFGRID_LICENSE_SMOKE_CAPTURE: capture,
        OFFGRID_LICENSE_SMOKE_PROFILE_ROOT: root,
        OFFGRID_SEED: 'force',
        OFFGRID_SEED_PRO: 'force'
      })

      expect(result.error).toBeUndefined()
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1)
      expect(result.stderr).toContain('expected window.api.isPro to be false, received true')
      const environment = JSON.parse(fs.readFileSync(capture, 'utf8')) as {
        profile: string
        pro: string
      }
      expect(environment.pro).toBe('1')
      expect(path.dirname(environment.profile)).toBe(root)
      expect(path.basename(environment.profile)).toMatch(/^offgrid-license-gate-/)
      expect(fs.existsSync(environment.profile), `${result.stdout}\n${result.stderr}`).toBe(false)
      expect(fs.readdirSync(root).sort()).toEqual([
        'electron-fixture',
        'electron-fixture-executable',
        'environment.json'
      ])
    }
  )

  const packagedExecutable = suppliedPackagedExecutable()
  it.runIf(process.platform === 'darwin' && Boolean(packagedExecutable))(
    'keeps the real packaged app free when OFFGRID_PRO=1 is injected',
    () => {
      const root = tempRoot()
      const result = runRunner(packagedExecutable, {
        OFFGRID_LICENSE_SMOKE_PROFILE_ROOT: root
      })

      expect(result.error).toBeUndefined()
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout).toContain('[license-smoke] packaged license gate passed')
      expect(fs.readdirSync(root)).toEqual([])
    },
    REAL_APP_TIMEOUT_MS
  )
})
