/**
 * APP-106 — a real Pro activation survives the required production relaunch.
 *
 * This spec starts from a clean, visibly free profile, creates a project and a
 * local chat through the rendered product, activates the user's real licence
 * against the production entitlement service, clicks the rendered Restart now
 * action, and attaches to the replacement Electron renderer. No licensing code
 * or response is faked. The sole controlled boundary is the native local-model
 * executable used to create a deterministic pre-activation chat.
 */
import { chromium, expect, test, type Browser, type CDPSession, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { licenseFixtureDir, targetIsPackaged } from './helpers/launch'
import { navButton } from './helpers/settings'

const PROJECT = 'APP-106 Existing Project'
const PROMPT = 'Keep this chat through the Pro activation restart.'
const ANSWER = 'APP-106 profile survives activation.'
const ACTIVATED = 'Activated. Restart to finish unlocking Pro.'

let appProcess: ChildProcess | null = null
let browser: Browser | null = null
let browserPid: number | null = null
let page: Page
let rootDir: string
let profileDir: string
let binDir: string
let debuggingPort: number
let sanitizedProviderEvidence: string[] = []
let flushProviderOutput: Array<() => void> = []

const SAFE_PROVIDER_EVIDENCE =
  /^\[Keygen\] stage=(validate|create|list|update|delete) (status=\d{3} durationMs=\d+|outcome=(timeout|network_error) durationMs=\d+( timeoutMs=\d+)?)$/

function collectSanitizedProviderOutput(stream: NodeJS.ReadableStream | null): void {
  if (!stream) return
  let pending = ''
  const retainSafeLines = (complete: boolean): void => {
    const lines = pending.split(/\r?\n/)
    pending = complete ? '' : (lines.pop() ?? '')
    for (const line of lines) {
      const candidate = line.trim()
      if (SAFE_PROVIDER_EVIDENCE.test(candidate)) sanitizedProviderEvidence.push(candidate)
    }
    if (complete) {
      const candidate = pending.trim()
      if (SAFE_PROVIDER_EVIDENCE.test(candidate)) sanitizedProviderEvidence.push(candidate)
      pending = ''
    }
  }
  stream.on('data', (chunk: Buffer | string) => {
    pending += chunk.toString()
    retainSafeLines(false)
  })
  flushProviderOutput.push(() => retainSafeLines(true))
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  await expect.poll(() => processIsAlive(pid), { timeout: 15_000 }).toBe(false)
}

async function closeApp(): Promise<void> {
  const pid = browserPid ?? appProcess?.pid ?? null
  browserPid = null
  if (pid && processIsAlive(pid)) {
    process.kill(pid, 'SIGTERM')
    try {
      await waitForProcessExit(pid)
    } catch {
      if (processIsAlive(pid)) process.kill(pid, 'SIGKILL')
      await waitForProcessExit(pid)
    }
  }
  await browser?.close().catch(() => {})
  browser = null
  appProcess = null
}

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Could not reserve a Chromium debugging port')
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return address.port
}

function secureFixturePath(name: 'key.txt' | 'device-fingerprint'): string {
  const filePath = path.join(licenseFixtureDir(), name)
  const stat = fs.statSync(filePath)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error(`APP-106 requires a private regular ${name} fixture (mode 0600)`)
  }
  return filePath
}

function installLocalModelBoundary(): void {
  const modelsDir = path.join(profileDir, 'models')
  const llamaDir = path.join(binDir, 'llama')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })

  const model = Buffer.alloc(2_048)
  model.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'app106-local.gguf'), model)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'app106-local-model', primary: 'app106-local.gguf', mmproj: null })
  )

  const executable = path.join(llamaDir, 'llama-server')
  fs.copyFileSync(
    path.join(process.cwd(), 'e2e', 'fixtures', 'app106-license-preservation-llama-server.mjs'),
    executable
  )
  fs.chmodSync(executable, 0o755)
}

function seedStableInstallationIdentity(): void {
  fs.mkdirSync(profileDir, { recursive: true })
  fs.copyFileSync(
    secureFixturePath('device-fingerprint'),
    path.join(profileDir, 'device-fingerprint')
  )
  expect(fs.existsSync(path.join(profileDir, 'license.json'))).toBe(false)
}

function launchEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OFFGRID_USER_DATA: profileDir,
    OFFGRID_BIN_DIR: binDir,
    NODE_ENV: 'production',
    NO_PROXY: '127.0.0.1,localhost'
  }
  // APP-106 must use the real entitlement provider. Either forced value would
  // bypass or disable the exact production path under test.
  delete env.OFFGRID_PRO
  return env
}

async function openSidebar(name: 'Projects' | 'Chat' | 'Day' | 'Devices'): Promise<void> {
  const control = navButton(page, name)
  await expect(control).toBeVisible()
  await control.click()
}

async function createVisibleProject(): Promise<void> {
  await openSidebar('Projects')
  await page.getByTitle('New project').click()
  await page.getByPlaceholder('Project name…').fill(PROJECT)
  await page.keyboard.press('Enter')
  await expect(page.getByText(PROJECT, { exact: true }).first()).toBeVisible()
}

async function createVisibleChat(): Promise<void> {
  await openSidebar('Chat')
  const composer = page.getByPlaceholder(/ask anything/i)
  await expect(composer).toBeVisible()
  await composer.fill(PROMPT)
  await page.keyboard.press('Enter')
  await expect(page.getByText(PROMPT, { exact: true }).last()).toBeVisible()
  await expect(page.getByText(ANSWER, { exact: true }).last()).toBeVisible({ timeout: 30_000 })
}

async function connectToRunningApp(): Promise<void> {
  const endpoint = `http://127.0.0.1:${debuggingPort}`
  await expect
    .poll(
      async () => {
        try {
          browser = await chromium.connectOverCDP(endpoint)
          return true
        } catch {
          return false
        }
      },
      { timeout: 30_000, intervals: [100, 200, 500] }
    )
    .toBe(true)

  if (!browser) throw new Error('Electron browser was not reachable')
  const session: CDPSession = await browser.newBrowserCDPSession()
  const processInfo = (await session.send('SystemInfo.getProcessInfo')) as {
    processInfo: Array<{ id: number; type: string }>
  }
  browserPid = processInfo.processInfo.find((entry) => entry.type === 'browser')?.id ?? null
  await session.detach()
  if (!browserPid) throw new Error('Electron process identity was unavailable')

  await expect
    .poll(
      () =>
        browser
          ?.contexts()
          .flatMap((context) => context.pages())
          .filter((candidate) => !candidate.isClosed()).length ?? 0,
      { timeout: 30_000, intervals: [100, 200, 500] }
    )
    .toBeGreaterThan(0)

  page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => !candidate.isClosed()) as Page
  await page.waitForLoadState('domcontentloaded')
  await page.emulateMedia({ reducedMotion: 'reduce' })
}

async function launchActualElectron(): Promise<void> {
  const executable = path.join(
    process.cwd(),
    'node_modules',
    'electron',
    'dist',
    'Electron.app',
    'Contents',
    'MacOS',
    'Electron'
  )
  if (!fs.existsSync(executable)) throw new Error('Electron runtime is not installed')
  appProcess = spawn(executable, ['.', `--remote-debugging-port=${debuggingPort}`], {
    cwd: process.cwd(),
    env: launchEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  collectSanitizedProviderOutput(appProcess.stdout)
  collectSanitizedProviderOutput(appProcess.stderr)
  await new Promise<void>((resolve, reject) => {
    appProcess?.once('spawn', resolve)
    appProcess?.once('error', reject)
  })
  await connectToRunningApp()
  expect(browserPid).toBe(appProcess.pid)
}

async function restartThroughRenderedUi(): Promise<void> {
  if (!appProcess) throw new Error('Electron app is not running')
  const oldChild = appProcess
  await page.getByRole('button', { name: 'Restart now', exact: true }).click()
  await waitForExit(oldChild)
  appProcess = null
  browser = null
  browserPid = null
  await connectToRunningApp()
}

test.describe('APP-106 real licence activation', () => {
  test.skip(
    process.platform !== 'darwin',
    'APP-106 currently verifies the macOS platform identity.'
  )
  test.skip(targetIsPackaged(), 'The deterministic native-model boundary targets the source build.')
  test.describe.configure({ mode: 'serial', timeout: 180_000 })

  test.beforeEach(async () => {
    sanitizedProviderEvidence = []
    flushProviderOutput = []
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-app106-'))
    profileDir = path.join(rootDir, 'profile')
    binDir = path.join(rootDir, 'bin')
    debuggingPort = await reservePort()
    seedStableInstallationIdentity()
    installLocalModelBoundary()

    await launchActualElectron()
    await completeOnboarding(page)
  })

  test.afterEach(async ({ browserName: _browserName }, testInfo) => {
    await closeApp()
    for (const flush of flushProviderOutput) flush()
    await testInfo.attach('app106-sanitized-provider-evidence', {
      body: Buffer.from(
        sanitizedProviderEvidence.join('\n') || 'No sanitized provider stage/status was emitted.'
      ),
      contentType: 'text/plain'
    })
    if (rootDir && path.basename(rootDir).startsWith('offgrid-app106-')) {
      fs.rmSync(rootDir, { recursive: true, force: true })
    }
  })

  // Playwright requires the first callback argument to use object destructuring.
  // eslint-disable-next-line no-empty-pattern
  test('unlocks Pro through the real service and keeps the existing profile after Restart now', async ({}, testInfo) => {
    await createVisibleProject()
    await createVisibleChat()

    await openSidebar('Day')
    await expect(page.getByText('Off Grid AI Pro · Available now', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.api.isPro)).toBe(false)
    expect((await page.evaluate(() => window.api.license?.status())).isPro).toBe(false)

    const keyInput = page.getByPlaceholder('XXXX-XXXX-XXXX-XXXX')
    let licenceKey = fs.readFileSync(secureFixturePath('key.txt'), 'utf8').trim()
    expect(licenceKey.length).toBeGreaterThan(0)
    await keyInput.fill(licenceKey)
    licenceKey = ''
    const activationPanel = keyInput.locator('xpath=../..')
    const activationMessages = activationPanel.locator(':scope > div')
    await page.getByRole('button', { name: 'Activate', exact: true }).click()
    // Remove the credential from the DOM before any diagnostic or screenshot can run.
    await keyInput.fill('')

    await expect(activationMessages).toHaveCount(2, { timeout: 90_000 })
    const activationOutcome = await activationMessages.nth(1).innerText()
    expect(activationOutcome).toContain(ACTIVATED)
    expect(await page.evaluate(() => window.api.license?.status())).toEqual(
      expect.objectContaining({ isPro: true, tier: 'lifetime' })
    )

    await restartThroughRenderedUi()

    await openSidebar('Projects')
    await expect(page.getByText(PROJECT, { exact: true }).first()).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('app106-project-after-pro-restart.png') })

    await openSidebar('Chat')
    await expect(page.getByText(PROMPT, { exact: true }).last()).toBeVisible()
    await expect(page.getByText(ANSWER, { exact: true }).last()).toBeVisible()

    await openSidebar('Devices')
    await expect(page.getByText('Off Grid AI Pro · Available now', { exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => window.api.isPro)).toBe(true)
    expect((await page.evaluate(() => window.api.license?.status())).isPro).toBe(true)

    const licensedDevices = page.getByRole('button', { name: /Manage licensed devices,/ })
    await expect(licensedDevices).toBeVisible({ timeout: 60_000 })
    await licensedDevices.click()
    await expect(page.getByRole('heading', { name: 'Licensed devices' })).toBeVisible()
    await expect(page.getByText('macOS · This device', { exact: true })).toBeVisible()
    await expect(page.getByText('Local', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.api.platform)).toBe('darwin')
    await page.screenshot({ path: testInfo.outputPath('app106-licensed-macos-after-restart.png') })
  })
})
