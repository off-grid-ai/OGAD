import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchOffGrid } from './helpers/launch'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import electronExecutable from 'electron'
import { GATEWAY_PORT, MEDIA_PORT } from '../src/shared/ports'
import { assertEnginePortsFree } from './helpers/ports'

const executable = electronExecutable as unknown as string

let app: ElectronApplication
let page: Page
let userDataDir: string
let secondProcess: ChildProcess | null = null

const waitForExit = async (child: ChildProcess, timeoutMs = 15_000): Promise<number | null> => {
  if (child.exitCode !== null) return child.exitCode
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Electron process did not exit')), timeoutMs)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
  })
}

const waitForOwnedPortsToClose = async (): Promise<void> => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const reachable = await Promise.all(
      [GATEWAY_PORT, MEDIA_PORT].map((port) =>
        fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(250) })
          .then(() => true)
          .catch(() => false)
      )
    )
    if (reachable.every((value) => !value)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Electron model ports remained reachable after app teardown')
}

// This whole spec is about exclusive ownership of the fixed model ports — including the
// teardown assertion that they close. It cannot share them with a running app, so it fails
// first and names the owner, rather than a misleading failure later or a silent skip.
test.beforeAll(async () => {
  await assertEnginePortsFree()
})

test.beforeEach(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-single-instance-e2e-'))
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterEach(async () => {
  const ownerProcess = app?.process()
  try {
    if (secondProcess?.exitCode === null) {
      secondProcess.kill('SIGKILL')
      await waitForExit(secondProcess)
    }
    await app?.close()
    if (ownerProcess) await waitForExit(ownerProcess)
    await waitForOwnedPortsToClose()
  } catch (error) {
    if (ownerProcess?.exitCode === null) ownerProcess.kill('SIGKILL')
    throw error
  } finally {
    secondProcess = null
    fs.rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('redirects a second launch to the running owner without starting competing model ports', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize())
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized())
    )
    .toBe(true)

  secondProcess = spawn(executable, ['.'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const second = secondProcess
  let secondOutput = ''
  second.stdout?.on('data', (chunk) => {
    secondOutput += String(chunk)
  })
  second.stderr?.on('data', (chunk) => {
    secondOutput += String(chunk)
  })

  expect(await waitForExit(second)).toBe(0)
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized())
    )
    .toBe(false)
  await expect(page.locator('#root')).not.toBeEmpty()
  expect(app.process().exitCode).toBeNull()
  expect(secondOutput).not.toMatch(/EADDRINUSE|model[^\n]*corrupt/i)

  const gatewayHealthy = await fetch('http://127.0.0.1:7878/health')
    .then((response) => response.ok)
    .catch(() => false)
  expect(gatewayHealthy).toBe(true)
})

const minimizeOwner = async (): Promise<void> => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize())
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized())
    )
    .toBe(true)
}

test('an offgrid:// link from a second launch brings the running app back (Windows, Linux)', async () => {
  await minimizeOwner()

  // Windows and Linux start the app with the link as an argument; the lock sends it to the owner.
  secondProcess = spawn(executable, ['.', 'offgrid://open'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production'
    },
    stdio: 'ignore'
  })

  expect(await waitForExit(secondProcess)).toBe(0)
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized())
    )
    .toBe(false)
  await expect(page.locator('#root')).not.toBeEmpty()
})

test('an offgrid:// link brings the running app back (macOS open-url)', async () => {
  await minimizeOwner()

  // macOS delivers the link to the running app as open-url; the OS is the only part not real here.
  const handled = await app.evaluate(({ app: electronApp }) => {
    let prevented = false
    electronApp.emit(
      'open-url',
      {
        preventDefault: () => {
          prevented = true
        }
      },
      'offgrid://open'
    )
    return prevented
  })

  expect(handled).toBe(true)
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized())
    )
    .toBe(false)
  await expect(page.locator('#root')).not.toBeEmpty()
})
