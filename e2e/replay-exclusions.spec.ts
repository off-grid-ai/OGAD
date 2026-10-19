/**
 * Excluding an app in Replay stops its frames, and the exclusion survives a relaunch.
 *
 * Real Replay screen, capture settings panel, capture policy, scheduler and frame store. The
 * boundary is macOS: the APP-120 native fixture reports the active window and returns the pixels,
 * and the test chooses which app is in front through its control file.
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { targetIsPackaged } from './helpers/launch'
import { closeAndWait } from './helpers/windows'

const EXCLUDED = 'Secret Ledger'
const ALLOWED = 'Northwind Notes'

let app: ElectronApplication | null = null
let page: Page
let userDataDir: string
let controlPath: string

/** The window in front, as macOS would report it. */
const inFront = (appName: string, windowTitle: string): void => {
  const next = `${controlPath}.next`
  fs.writeFileSync(
    next,
    JSON.stringify({
      permission: 'granted',
      captureMode: 'normal',
      surface: {
        appName,
        windowTitle,
        url: `offgrid-e2e://replay-exclusions/${encodeURIComponent(windowTitle)}`
      }
    })
  )
  fs.renameSync(next, controlPath)
}

/** Native calls the app made, from the boundary's ledger. */
const nativeCalls = (event: 'active-window' | 'frame-capture', appName?: string): number => {
  const ledger = path.join(userDataDir, 'native-ledger.jsonl')
  if (!fs.existsSync(ledger)) return 0
  return fs
    .readFileSync(ledger, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; appName?: string })
    .filter((entry) => entry.event === event && (!appName || entry.appName === appName)).length
}

const capturedPngs = (): number => {
  const directory = path.join(userDataDir, 'captures')
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).filter((name) => name.endsWith('.png')).length
    : 0
}

const launch = async (): Promise<void> => {
  app = await electron.launch({
    args: [path.resolve('e2e/fixtures/app120-app122-capture-privacy-native-boundary.cjs')],
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_APP120_APP122_NATIVE_LEDGER: path.join(userDataDir, 'native-ledger.jsonl'),
      OFFGRID_APP120_APP122_NATIVE_CONTROL: controlPath,
      OFFGRID_PRO: '1',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await completeOnboarding(page)
}

const gotoReplay = async (): Promise<void> => {
  const expand = page.getByRole('button', { name: 'Expand sidebar' })
  if (await expand.isVisible().catch(() => false)) await expand.click()
  await page
    .getByRole('button', { name: /^Replay( Pro)?$/ })
    .first()
    .click()
  await expect(page.getByRole('heading', { name: 'Replay' })).toBeVisible()
}

test.describe('Replay exclusions', () => {
  test.skip(targetIsPackaged(), 'The native capture boundary targets the source-built app.')

  test.beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-replay-exclusions-'))
    controlPath = path.join(userDataDir, 'native-control.json')
  })

  test.afterEach(async () => {
    if (app) await closeAndWait(app)
    app = null
    fs.rmSync(userDataDir, { recursive: true, force: true })
  })

  test('an excluded app adds no frames, before or after a relaunch', async () => {
    test.setTimeout(240_000)
    inFront(ALLOWED, 'Weekly plan')
    await launch()

    // Capture is paused on a new profile until the person resumes it.
    const settings = page.getByRole('button', { name: 'Settings', exact: true }).first()
    await settings.click()
    const section = page.getByRole('button', { name: /^(All settings\s*)?Capture & processing/ })
    if ((await section.getAttribute('aria-expanded')) !== 'true') await section.click()
    await page.getByRole('button', { name: 'Resume capture' }).click()
    await expect.poll(capturedPngs, { timeout: 15_000 }).toBe(1)

    // Replay → Capture settings → Excluded apps: add the app.
    await gotoReplay()
    await page.getByRole('button', { name: 'Capture settings' }).click()
    await page.getByRole('textbox', { name: 'App name to exclude' }).fill(EXCLUDED)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(
      page.getByRole('button', { name: `Remove ${EXCLUDED} from excluded apps` })
    ).toBeVisible()
    await page.getByRole('button', { name: 'Close capture settings' }).click()

    // The excluded app in front: the app sees it, and takes no screenshot and keeps no frame.
    const screenshots = nativeCalls('frame-capture')
    inFront(EXCLUDED, 'Payroll figures')
    await expect
      .poll(() => nativeCalls('active-window', EXCLUDED), { timeout: 15_000 })
      .toBeGreaterThan(2)
    await page.waitForTimeout(12_000)
    expect(nativeCalls('frame-capture')).toBe(screenshots)
    expect(capturedPngs()).toBe(1)

    // Another app in front: it is captured again.
    inFront(ALLOWED, 'Launch checklist')
    await expect.poll(capturedPngs, { timeout: 15_000 }).toBe(2)

    // After a relaunch the exclusion still holds.
    await closeAndWait(app!)
    app = null
    inFront(EXCLUDED, 'Payroll figures, again')
    const screenshotsBefore = nativeCalls('frame-capture')
    await launch()
    await expect
      .poll(() => nativeCalls('active-window', EXCLUDED), { timeout: 30_000 })
      .toBeGreaterThan(5)
    await page.waitForTimeout(12_000)
    expect(nativeCalls('frame-capture')).toBe(screenshotsBefore)
    expect(capturedPngs()).toBe(2)
    await gotoReplay()
    await page.getByRole('button', { name: 'Capture settings' }).click()
    await expect(
      page.getByRole('button', { name: `Remove ${EXCLUDED} from excluded apps` })
    ).toBeVisible()
    await page.getByRole('button', { name: 'Close capture settings' }).click()
    inFront(ALLOWED, 'Retro notes')
    await expect.poll(capturedPngs, { timeout: 15_000 }).toBe(3)
  })
})
