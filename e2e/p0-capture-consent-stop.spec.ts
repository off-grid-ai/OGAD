/**
 * APP-119 + APP-121: rendered, fresh-profile capture consent and stop journey.
 *
 * The only controlled code is the native TCC / desktop-capture / active-window edge installed by
 * the Electron bootstrap fixture. Everything from the capture scheduler upward is the built
 * production app.
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

interface BoundaryEvent {
  event:
    | 'fixture-ready'
    | 'permission-read'
    | 'source-enumeration'
    | 'active-window'
    | 'frame-capture'
}

let app: ElectronApplication
let page: Page
let userDataDir: string
let ledgerPath: string
let screenshotPath: string

const boundaryEvents = (): BoundaryEvent[] => {
  if (!fs.existsSync(ledgerPath)) return []
  return fs
    .readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BoundaryEvent)
}

const eventCount = (event: BoundaryEvent['event']): number =>
  boundaryEvents().filter((entry) => entry.event === event).length

const capturedPngs = (): string[] => {
  const capturesDir = path.join(userDataDir, 'captures')
  if (!fs.existsSync(capturesDir)) return []
  return fs.readdirSync(capturesDir).filter((name) => name.endsWith('.png'))
}

const expandSidebar = async (): Promise<void> => {
  const button = page.getByRole('button', { name: 'Expand sidebar' })
  if (await button.isVisible().catch(() => false)) await button.click()
}

const gotoCaptureSettings = async (): Promise<void> => {
  await expandSidebar()
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  const header = page.getByRole('button', { name: /^(All settings\s*)?Capture & processing/ })
  await expect(header).toBeVisible()
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'true')
}

const captureGroup = (): ReturnType<Page['getByRole']> =>
  page.getByRole('group', { name: 'Capture' })

test.beforeAll(async () => {
  test.setTimeout(90_000)
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-p0-capture-consent-stop-'))
  ledgerPath = path.join(userDataDir, 'p0-capture-native-ledger.jsonl')
  screenshotPath = path.join(os.tmpdir(), 'offgrid-p0-capture-paused-render.png')
  const boundaryFixture = path.resolve('e2e/fixtures/p0-capture-native-boundary.cjs')

  app = await electron.launch({
    args: [boundaryFixture],
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_P0_CAPTURE_NATIVE_LEDGER: ledgerPath,
      OFFGRID_PRO: '1',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
  await expect.poll(() => eventCount('fixture-ready')).toBe(1)
  expect(await page.evaluate(() => window.api.isPro)).toBe(true)
})

test.afterAll(async () => {
  await app?.close().catch(() => {})
  // Keep the rendered evidence long enough for this process to inspect it, then leave no profile.
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('APP-119 and APP-121: capture requires opt-in, then pause stops it everywhere', async () => {
  test.setTimeout(90_000)
  await gotoCaptureSettings()

  // A new device is paused by Off Grid even though the controlled OS boundary says permission is
  // granted. Waiting past a full scheduler interval proves this is not a first-paint race.
  const settingsStatus = page.getByRole('status').filter({ hasText: 'Paused' }).first()
  await expect(settingsStatus).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resume capture' })).toBeVisible()
  await expect(page.getByText('Last frame').locator('..')).toContainText('none yet')
  await page.waitForTimeout(5_750)
  expect(eventCount('active-window')).toBe(0)
  expect(eventCount('frame-capture')).toBe(0)
  expect(capturedPngs()).toHaveLength(0)

  // Consent is a real rendered action. The production IPC clears the persisted user pause, the
  // production scheduler runs, and the production vision/frame store writes the synthetic native
  // frame into this fresh profile.
  await page.getByRole('button', { name: 'Resume capture' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Capturing' }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pause capture' })).toBeVisible()
  await expect.poll(() => eventCount('frame-capture'), { timeout: 12_000 }).toBeGreaterThan(0)
  await expect.poll(() => capturedPngs().length).toBeGreaterThan(0)
  await expect(page.getByText('Last frame').locator('..')).not.toContainText('none yet')

  // Replay consumes the same live production projection. Pausing there must update the visible
  // state immediately, then remain stopped for more than one scheduler interval.
  await expandSidebar()
  await page
    .getByRole('button', { name: /^Replay( Pro)?$/ })
    .first()
    .click()
  await expect(page.getByRole('heading', { name: 'Replay' })).toBeVisible()
  await expect(captureGroup()).toContainText('Capturing')
  await captureGroup().getByRole('button', { name: 'Pause capture' }).click()
  await expect(captureGroup()).toContainText('Paused')
  await expect(captureGroup().getByRole('button', { name: 'Resume capture' })).toBeVisible()

  const framesAtPause = eventCount('frame-capture')
  const pngsAtPause = capturedPngs().length
  await page.screenshot({ path: screenshotPath })
  await page.waitForTimeout(5_750)
  expect(eventCount('frame-capture')).toBe(framesAtPause)
  expect(capturedPngs()).toHaveLength(pngsAtPause)

  // A second rendered surface must agree without a reload, proving pause is authoritative rather
  // than a Replay-only label.
  await gotoCaptureSettings()
  await expect(page.getByRole('status').filter({ hasText: 'Paused' }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resume capture' })).toBeVisible()
  expect(fs.statSync(screenshotPath).size).toBeGreaterThan(0)
})
