/**
 * APP-142 — meeting recording is explicit, visible, singular, and releasable.
 *
 * The rendered Meetings screen drives the real preload/IPC, singleton
 * MeetingController, service wiring, tray hook, and finalization pipeline. Only the
 * native recorder executable is controlled; its audit ledger proves how many OS
 * recorder lifecycles production code actually started and whether the child exited.
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { targetIsPackaged } from './helpers/launch'
import { navButton } from './helpers/settings'

interface RecorderEvent {
  event: 'started' | 'stopped' | 'media-error'
  pid: number
  signal?: string
  outputDirectory?: string
}

interface MeetingState {
  recording: boolean
  busy: boolean
  startedAt: number
  error: string
}

let app: ElectronApplication | null = null
let page: Page
let rootDir: string
let profileDir: string
let boundaryRoot: string
let recorderExecutable: string
let auditFile: string

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

function readAudit(): RecorderEvent[] {
  if (!fs.existsSync(auditFile)) return []
  return fs
    .readFileSync(auditFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecorderEvent)
}

async function meetingState(): Promise<MeetingState> {
  return page.evaluate(() => window.api.meetingGetState()) as Promise<MeetingState>
}

function installRecorderBoundary(): void {
  const targetDir = path.join(boundaryRoot, 'scripts', 'meeting-recorder')
  fs.mkdirSync(targetDir, { recursive: true })
  recorderExecutable = path.join(targetDir, 'meeting-recorder')
  fs.copyFileSync(
    path.join(process.cwd(), 'e2e', 'fixtures', 'app142-meeting-recorder-boundary.mjs'),
    recorderExecutable
  )
  fs.chmodSync(recorderExecutable, 0o755)
}

function ffmpegPath(): string {
  const candidates = [
    path.join(process.cwd(), 'resources', 'bin', 'ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg'
  ]
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (!found) throw new Error('APP-142 requires an installed ffmpeg executable')
  return found
}

async function launchApp(): Promise<void> {
  app = await electron.launch({
    args: [process.cwd()],
    cwd: boundaryRoot,
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_PRO: '1',
      OFFGRID_APP142_AUDIT_FILE: auditFile,
      OFFGRID_APP142_FFMPEG: ffmpegPath(),
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await completeOnboarding(page)
}

async function closeApp(): Promise<void> {
  const running = app
  app = null
  if (!running) return
  const child = running.process()
  await running.close().catch(() => {})
  await waitForExit(child)
}

test.describe('APP-142 explicit meeting recording lifecycle', () => {
  test.skip(targetIsPackaged(), 'The native recorder boundary targets the source-built app.')
  test.skip(process.platform !== 'darwin', 'The production meeting recorder is macOS-only.')
  test.describe.configure({ mode: 'serial', timeout: 120_000 })

  test.beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-app142-'))
    profileDir = path.join(rootDir, 'profile')
    boundaryRoot = path.join(rootDir, 'boundary')
    auditFile = path.join(rootDir, 'recorder-audit.jsonl')
    installRecorderBoundary()
    await launchApp()
  })

  test.afterEach(async () => {
    await closeApp()
    for (const event of readAudit()) {
      if (event.pid && processIsAlive(event.pid)) {
        process.kill(event.pid, 'SIGKILL')
        await expect.poll(() => processIsAlive(event.pid)).toBe(false)
      }
    }
    if (rootDir && path.basename(rootDir).startsWith('offgrid-app142-')) {
      fs.rmSync(rootDir, { recursive: true, force: true })
    }
  })

  // Playwright requires the first callback argument to use object destructuring.
  // eslint-disable-next-line no-empty-pattern
  test('starts no recorder before consent, shows one live lifecycle, and releases it on Stop', async ({}, testInfo) => {
    await navButton(page, 'Meetings').click()
    await expect(page.getByRole('heading', { name: 'Meetings', level: 1 })).toBeVisible()

    await expect(page.getByRole('button', { name: 'Record meeting', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Stop ·/ })).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: /Recording meeting · .*click to stop/ })
    ).toHaveCount(0)
    expect(await meetingState()).toEqual(
      expect.objectContaining({ recording: false, busy: false, startedAt: 0, error: '' })
    )
    expect(fs.existsSync(auditFile)).toBe(false)

    await page.getByRole('button', { name: 'Record meeting', exact: true }).click()

    const stopButton = page.getByRole('button', { name: /^Stop · \d+s$/ })
    await expect(stopButton).toBeVisible()
    const globalIndicator = page.getByRole('button', {
      name: /Recording meeting · 0:\d{2} · click to stop/
    })
    await expect(globalIndicator).toBeVisible()
    await expect(
      page.getByText(
        'Recording your current screen + speaker audio + mic, on device. It stops automatically when the call ends, or hit Stop.',
        { exact: true }
      )
    ).toBeVisible()

    await expect.poll(() => readAudit().filter((event) => event.event === 'started').length).toBe(1)
    const [started] = readAudit().filter((event) => event.event === 'started')
    expect(started).toBeDefined()
    expect(processIsAlive(started!.pid)).toBe(true)
    expect(await meetingState()).toEqual(
      expect.objectContaining({ recording: true, busy: false, error: '' })
    )
    await expect(stopButton).toHaveAccessibleName(/^Stop · [1-9]\d*s$/, { timeout: 10_000 })
    await page.screenshot({ path: testInfo.outputPath('app142-visible-recording-indicators.png') })

    await stopButton.click()

    await expect(page.getByRole('button', { name: 'Record meeting', exact: true })).toBeVisible({
      timeout: 30_000
    })
    await expect(globalIndicator).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Stop ·/ })).toHaveCount(0)
    expect(await meetingState()).toEqual(
      expect.objectContaining({ recording: false, busy: false, startedAt: 0, error: '' })
    )

    await expect.poll(() => readAudit().filter((event) => event.event === 'stopped').length).toBe(1)
    const audit = readAudit()
    expect(audit.filter((event) => event.event === 'started')).toHaveLength(1)
    expect(audit.filter((event) => event.event === 'stopped')).toHaveLength(1)
    expect(audit.find((event) => event.event === 'stopped')?.signal).toBe('SIGINT')
    expect(processIsAlive(started!.pid)).toBe(false)
  })
})
