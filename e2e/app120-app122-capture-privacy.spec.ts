/**
 * APP-120 + APP-122: permission recovery and capture privacy through rendered production UI.
 *
 * Only macOS-native facts are controlled: TCC, System Settings, process replacement, session lock,
 * active-window identity, and ScreenCaptureKit's pixels. Settings/Replay, IPC, the scheduler,
 * capture policy, frame store, and relaunch persistence are all the built application.
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

type NativeEventName =
  | 'fixture-ready'
  | 'permission-read'
  | 'permission-request'
  | 'open-system-settings'
  | 'application-relaunch'
  | 'source-enumeration'
  | 'active-window'
  | 'frame-capture'

interface NativeEvent {
  event: NativeEventName
  permission?: string
  target?: string
  appName?: string
  captureMode?: string
}

interface NativeControl {
  permission: 'denied' | 'granted'
  captureMode: 'normal' | 'blank'
  surface: {
    appName: string
    windowTitle: string
    url: string
  }
}

let app: ElectronApplication
let page: Page
let userDataDir: string
let ledgerPath: string
let controlPath: string
let deniedScreenshotPath: string
let recoveredScreenshotPath: string

const readEvents = (): NativeEvent[] => {
  if (!fs.existsSync(ledgerPath)) return []
  return fs
    .readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as NativeEvent)
}

const countEvent = (event: NativeEventName, predicate?: (entry: NativeEvent) => boolean): number =>
  readEvents().filter((entry) => entry.event === event && (!predicate || predicate(entry))).length

const writeControl = (control: NativeControl): void => {
  const next = `${controlPath}.next`
  fs.writeFileSync(next, JSON.stringify(control))
  fs.renameSync(next, controlPath)
}

const control = (
  permission: NativeControl['permission'],
  captureMode: NativeControl['captureMode'],
  appName: string,
  windowTitle: string
): NativeControl => ({
  permission,
  captureMode,
  surface: {
    appName,
    windowTitle,
    url: `offgrid-e2e://capture-privacy/${encodeURIComponent(appName)}`
  }
})

const capturedPngs = (): string[] => {
  const directory = path.join(userDataDir, 'captures')
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory).filter((name) => name.endsWith('.png'))
}

const launch = async (): Promise<void> => {
  const fixture = path.resolve('e2e/fixtures/app120-app122-capture-privacy-native-boundary.cjs')
  app = await electron.launch({
    args: [fixture],
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_APP120_APP122_NATIVE_LEDGER: ledgerPath,
      OFFGRID_APP120_APP122_NATIVE_CONTROL: controlPath,
      OFFGRID_PRO: '1',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
}

const expandSidebar = async (): Promise<void> => {
  const button = page.getByRole('button', { name: 'Expand sidebar' })
  if (await button.isVisible().catch(() => false)) await button.click()
}

const gotoCaptureSettings = async (): Promise<void> => {
  await expandSidebar()
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  const section = page.getByRole('button', { name: /^(All settings\s*)?Capture & processing/ })
  await expect(section).toBeVisible()
  if ((await section.getAttribute('aria-expanded')) !== 'true') await section.click()
  await expect(section).toHaveAttribute('aria-expanded', 'true')
}

const gotoReplay = async (): Promise<void> => {
  await expandSidebar()
  await page
    .getByRole('button', { name: /^Replay( Pro)?$/ })
    .first()
    .click()
  await expect(page.getByRole('heading', { name: 'Replay' })).toBeVisible()
}

const replayFrameCount = (): ReturnType<Page['getByText']> => page.getByText(/^\d+ frames$/)
const captureGroup = (): ReturnType<Page['getByRole']> =>
  page.getByRole('group', { name: 'Capture' })

test.beforeAll(async () => {
  test.setTimeout(150_000)
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-app120-app122-capture-privacy-'))
  ledgerPath = path.join(userDataDir, 'native-ledger.jsonl')
  controlPath = path.join(userDataDir, 'native-control.json')
  deniedScreenshotPath = path.join(os.tmpdir(), 'offgrid-app120-permission-denied.png')
  recoveredScreenshotPath = path.join(os.tmpdir(), 'offgrid-app122-capture-recovered.png')
  writeControl(
    control('denied', 'normal', 'APP-120 Permission Workbench', 'Permission recovery work')
  )
  await launch()
  await expect.poll(() => countEvent('fixture-ready')).toBe(1)
  expect(await page.evaluate(() => window.api.isPro)).toBe(true)
})

test.afterAll(async () => {
  await app?.close().catch(() => {})
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('APP-120 and APP-122: denied, locked, blank and sensitive content never leak into Replay', async () => {
  test.setTimeout(150_000)

  // APP-120 — denial is factual, blocks the scheduler before active-window/screen capture, and
  // provides a rendered route to the exact macOS recovery action.
  await gotoCaptureSettings()
  await expect(
    page.getByRole('status').filter({ hasText: 'Permission required' }).first()
  ).toBeVisible()
  await expect(page.getByText('Screen access').locator('..')).toContainText('denied')
  await expect(page.getByRole('button', { name: 'Review permissions' })).toBeVisible()
  await page.waitForTimeout(5_750)
  expect(countEvent('active-window')).toBe(0)
  expect(countEvent('frame-capture')).toBe(0)
  expect(capturedPngs()).toHaveLength(0)

  await page.getByRole('button', { name: 'Review permissions' }).click()
  const screenPermission = page.getByRole('status', { name: 'Screen Recording permission' }).last()
  await expect(screenPermission).toContainText('Permission needed')
  await screenPermission.getByRole('button', { name: 'Enable Screen Recording' }).click()
  await expect.poll(() => countEvent('permission-request')).toBe(1)
  await expect
    .poll(() =>
      countEvent(
        'open-system-settings',
        (entry) => entry.target?.includes('Privacy_ScreenCapture') === true
      )
    )
    .toBe(1)
  await expect(
    screenPermission.getByRole('button', {
      name: 'Relaunch Off Grid AI Desktop for Screen Recording'
    })
  ).toBeVisible()
  expect(capturedPngs()).toHaveLength(0)
  await page.screenshot({ path: deniedScreenshotPath })

  // macOS grants access out of process. The rendered Relaunch action still travels through the
  // production IPC/shutdown owner; the harness owns only Electron's replacement-process edge.
  writeControl(
    control('granted', 'normal', 'APP-120 Permission Workbench', 'Permission recovery work')
  )
  const closed = app.waitForEvent('close')
  await screenPermission
    .getByRole('button', { name: 'Relaunch Off Grid AI Desktop for Screen Recording' })
    .click()
  await closed
  await expect.poll(() => countEvent('application-relaunch')).toBe(1)

  await launch()
  await expect.poll(() => countEvent('fixture-ready')).toBe(2)
  await gotoCaptureSettings()

  // A successful grant and full runtime restart still cannot opt the user into capture. The fresh
  // profile remains deliberately paused until the rendered Resume action clears that persisted intent.
  await expect(page.getByRole('status').filter({ hasText: 'Paused' }).first()).toBeVisible()
  await expect(page.getByText('Screen access').locator('..')).toContainText('granted')
  const activeBeforeConsent = countEvent('active-window')
  await page.waitForTimeout(5_750)
  expect(countEvent('active-window')).toBe(activeBeforeConsent)
  expect(capturedPngs()).toHaveLength(0)

  await page.getByRole('button', { name: 'Resume capture' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Capturing' }).first()).toBeVisible()
  await expect.poll(() => capturedPngs().length, { timeout: 12_000 }).toBe(1)
  await gotoReplay()
  await expect(replayFrameCount()).toHaveText('1 frames')

  // APP-122 — locking macOS owns a distinct temporary pause. No native focus/capture call and no
  // stored frame may occur while locked; unlock must recover without stealing the user's consent.
  const nativeCallsBeforeLock = countEvent('active-window')
  const filesBeforeLock = capturedPngs().length
  writeControl(control('granted', 'normal', 'APP-122 Unlock Recovery', 'Safe work after unlocking'))
  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'))
  await expect(captureGroup()).toContainText('Paused by macOS')
  await page.waitForTimeout(5_750)
  expect(countEvent('active-window')).toBe(nativeCallsBeforeLock)
  expect(capturedPngs()).toHaveLength(filesBeforeLock)
  await expect(replayFrameCount()).toHaveText('1 frames')

  await app.evaluate(({ powerMonitor }) => powerMonitor.emit('unlock-screen'))
  await expect(captureGroup()).toContainText('Capturing')
  await expect.poll(() => capturedPngs().length, { timeout: 12_000 }).toBe(filesBeforeLock + 1)
  await expect(replayFrameCount()).toHaveText('2 frames')

  // A blank native frame crosses ScreenCaptureKit but is rejected before persistence. The short
  // title intentionally carries no Accessibility fallback material that could be retained instead.
  const filesBeforeBlank = capturedPngs().length
  const blankCallsBefore = countEvent('frame-capture', (entry) => entry.captureMode === 'blank')
  writeControl(control('granted', 'blank', 'APP-122 Blank Surface', 'Blank'))
  await expect
    .poll(() => countEvent('frame-capture', (entry) => entry.captureMode === 'blank'), {
      timeout: 12_000
    })
    .toBeGreaterThan(blankCallsBefore)
  await page.waitForTimeout(500)
  expect(capturedPngs()).toHaveLength(filesBeforeBlank)
  await expect(replayFrameCount()).toHaveText('2 frames')

  // A sensitive native app is denied by production capture policy before ScreenCaptureKit is ever
  // touched. This is stronger than deleting a frame after the fact: no pixels are acquired or kept.
  const sensitiveFocusBefore = countEvent('active-window', (entry) => entry.appName === '1Password')
  const frameCallsBeforeSensitive = countEvent('frame-capture')
  writeControl(control('granted', 'normal', '1Password', 'Private vault'))
  await expect
    .poll(() => countEvent('active-window', (entry) => entry.appName === '1Password'), {
      timeout: 12_000
    })
    .toBeGreaterThan(sensitiveFocusBefore)
  await page.waitForTimeout(500)
  expect(countEvent('frame-capture')).toBe(frameCallsBeforeSensitive)
  expect(capturedPngs()).toHaveLength(filesBeforeBlank)
  await expect(replayFrameCount()).toHaveText('2 frames')

  // The privacy gates are not a dead end. A subsequent ordinary surface enters the same production
  // scheduler and appears in Replay, proving safe recovery rather than a permanently wedged pipeline.
  writeControl(
    control('granted', 'normal', 'APP-122 Final Recovery', 'Safe capture after privacy gates')
  )
  await expect.poll(() => capturedPngs().length, { timeout: 12_000 }).toBe(filesBeforeBlank + 1)
  await expect(replayFrameCount()).toHaveText('3 frames')
  await expect(captureGroup()).toContainText('Capturing')
  await page.screenshot({ path: recoveredScreenshotPath })

  expect(fs.statSync(deniedScreenshotPath).size).toBeGreaterThan(0)
  expect(fs.statSync(recoveredScreenshotPath).size).toBeGreaterThan(0)
})
