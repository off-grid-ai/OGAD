/**
 * A recording that a Zoom call started stops by itself once the call ends.
 *
 * Real app, real MeetingController, presence detection, auto-stop policy and finalization. The
 * boundaries: Zoom's in-call process (`CptHost`, which detection finds with `pgrep -x`) is
 * `sleep` run through a link named CptHost, and the native recorder is the APP-142 executable whose ledger shows each
 * recorder start and stop. The call ending is the process going away; after the grace period
 * (5 minutes unconfirmed, then a 20 second warning) the recording stops.
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { targetIsPackaged } from './helpers/launch'
import { closeAndWait } from './helpers/windows'

interface RecorderEvent {
  event: 'started' | 'stopped' | 'media-error'
  pid: number
}

let app: ElectronApplication | null = null
let page: Page
let rootDir: string
let auditFile: string
let zoomCall: ChildProcess | null = null

const readAudit = (): RecorderEvent[] =>
  fs.existsSync(auditFile)
    ? fs
        .readFileSync(auditFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecorderEvent)
    : []

const recording = async (): Promise<boolean> =>
  ((await page.evaluate(() => window.api.meetingGetState())) as { recording: boolean }).recording

function ffmpegPath(): string {
  const found = [
    path.join(process.cwd(), 'resources', 'bin', 'ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg'
  ].find((candidate) => fs.existsSync(candidate))
  if (!found) throw new Error('The recorder boundary needs an installed ffmpeg executable')
  return found
}

/** Zoom's in-call process: `sleep` run as CptHost, alive while the call is. */
function joinZoomCall(): ChildProcess {
  // A link, not a copy: macOS kills a copied system binary, and the process takes the link's name.
  const binary = path.join(rootDir, 'CptHost')
  fs.symlinkSync('/bin/sleep', binary)
  return spawn(binary, ['3600'], { stdio: 'ignore' })
}

test.describe('Meeting auto-stop', () => {
  test.skip(targetIsPackaged(), 'The native recorder boundary targets the source-built app.')
  test.skip(process.platform !== 'darwin', 'The production meeting recorder is macOS-only.')

  test.beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-meeting-auto-stop-'))
    auditFile = path.join(rootDir, 'recorder-audit.jsonl')
    const boundaryRoot = path.join(rootDir, 'boundary')
    const recorderDir = path.join(boundaryRoot, 'scripts', 'meeting-recorder')
    fs.mkdirSync(recorderDir, { recursive: true })
    const recorder = path.join(recorderDir, 'meeting-recorder')
    fs.copyFileSync(path.resolve('e2e/fixtures/app142-meeting-recorder-boundary.mjs'), recorder)
    fs.chmodSync(recorder, 0o755)
    app = await electron.launch({
      args: [process.cwd()],
      cwd: boundaryRoot,
      env: {
        ...process.env,
        OFFGRID_USER_DATA: path.join(rootDir, 'profile'),
        OFFGRID_PRO: '1',
        OFFGRID_APP142_AUDIT_FILE: auditFile,
        OFFGRID_APP142_FFMPEG: ffmpegPath(),
        NODE_ENV: 'production'
      }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await completeOnboarding(page)
  })

  test.afterEach(async () => {
    zoomCall?.kill('SIGKILL')
    zoomCall = null
    if (app) await closeAndWait(app)
    app = null
    for (const { pid } of readAudit()) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('a recording the call started stops after the call ends', async () => {
    test.setTimeout(10 * 60_000)
    expect(await recording()).toBe(false)

    // The call starts: detection sees Zoom in a meeting and starts one recording.
    zoomCall = joinZoomCall()
    await expect.poll(recording, { timeout: 30_000 }).toBe(true)
    await expect
      .poll(() => readAudit().filter(({ event }) => event === 'started').length, {
        timeout: 30_000
      })
      .toBe(1)
    await expect(
      page.getByRole('button', { name: /^Recording Zoom · .*click to stop/ })
    ).toBeVisible()

    // The call ends. The recording keeps going through the grace period, then stops by itself.
    zoomCall.kill('SIGTERM')
    zoomCall = null
    await page.waitForTimeout(60_000)
    expect(await recording()).toBe(true)
    await expect.poll(recording, { timeout: 7 * 60_000, intervals: [5_000] }).toBe(false)
    await expect
      .poll(() => readAudit().filter(({ event }) => event === 'stopped').length, {
        timeout: 30_000
      })
      .toBe(1)
    expect(readAudit().filter(({ event }) => event === 'started')).toHaveLength(1)
    await expect(
      page.getByRole('button', { name: /^Recording Zoom · .*click to stop/ })
    ).toHaveCount(0)
  })
})
