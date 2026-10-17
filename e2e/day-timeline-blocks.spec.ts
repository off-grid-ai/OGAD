/**
 * The Day timeline shows one block per window the person worked in, and Reflect agrees.
 *
 * Real app, real Day and Reflect screens and the real block rules (pro/main/crm/segments.ts):
 * a frame earns the time to the next frame, at most 90 seconds; a gap over 5 minutes earns
 * nothing and starts a new block; the last frame earns 30 seconds; a block is named by its window.
 * The boundary is the capture itself: frames for two apps, six minutes apart, are seeded into a
 * profile before launch, and background capture is off so nothing else lands in the day.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'
import { closeAndWait } from './helpers/windows'

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))

let app: ElectronApplication | null = null
let page: Page
let profileDir: string

interface Block {
  label: string
  surface: string
  activeSec: number
}

/** Seconds since the epoch of the first seeded frame: today, before now, after local midnight. */
function firstFrameSec(): number {
  const now = Math.floor(Date.now() / 1000)
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  return Math.max(now - 30 * 60, Math.floor(midnight.getTime() / 1000) + 60)
}

const sqliteTime = (sec: number): string =>
  new Date(sec * 1000).toISOString().slice(0, 19).replace('T', ' ')

/** Ledger for 4 frames a minute apart, then Mail six minutes later. */
function seedFrames(t0: number): void {
  const frames: Array<[number, string, string]> = [
    [t0, 'Ledger', 'Quarterly budget'],
    [t0 + 60, 'Ledger', 'Quarterly budget'],
    [t0 + 120, 'Ledger', 'Quarterly budget'],
    [t0 + 180, 'Ledger', 'Quarterly budget'],
    [t0 + 540, 'Mail', 'Harbour contract'],
    [t0 + 630, 'Mail', 'Harbour contract'],
    [t0 + 720, 'Mail', 'Harbour contract'],
    [t0 + 750, 'Mail', 'Harbour contract']
  ]
  const rows = frames
    .map(([sec, app, title]) => `('${sqliteTime(sec)}', '${app}', '${app}', '${title}', 'ax')`)
    .join(',\n')
  // A profile from before encryption: the app opens a memories.db without a key as plaintext.
  execFileSync('sqlite3', [
    path.join(profileDir, 'memories.db'),
    `CREATE TABLE frames (
       id INTEGER PRIMARY KEY AUTOINCREMENT, ts DATETIME DEFAULT CURRENT_TIMESTAMP,
       surface TEXT, app TEXT, window_title TEXT, url TEXT, image_path TEXT, text TEXT,
       source TEXT, processing_status TEXT NOT NULL DEFAULT 'observed', processing_error TEXT,
       processing_error_code TEXT, processed_at DATETIME,
       attempt_count INTEGER NOT NULL DEFAULT 0,
       transient_failure_count INTEGER NOT NULL DEFAULT 0, retry_after DATETIME,
       blocked_min_context INTEGER
     );
     INSERT INTO frames (ts, surface, app, window_title, source) VALUES ${rows};`
  ])
}

const nav = (name: string): ReturnType<Page['getByRole']> =>
  page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })

test.describe('Day timeline', () => {
  test.skip(targetIsPackaged(), 'Source build with a seeded Pro profile')

  test.beforeEach(async () => {
    test.skip(!PRO_PRESENT, 'pro package not present: Day is a Pro surface')
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-day-blocks-'))
  })

  test.afterEach(async () => {
    if (app) await closeAndWait(app)
    app = null
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('two apps six minutes apart are two blocks, timed by the frame rules', async () => {
    const t0 = firstFrameSec()
    seedFrames(t0)
    app = await launchOffGrid({
      env: {
        ...process.env,
        OFFGRID_USER_DATA: profileDir,
        OFFGRID_E2E_LICENSE_FIXTURE: path.join(profileDir, 'no-license'),
        OFFGRID_PRO: '1',
        OFFGRID_NO_SERVICES: '1',
        NODE_ENV: 'production'
      }
    })
    page = await app.firstWindow()
    await completeOnboarding(page)

    // Ledger: 3 × 60 s, and the 6-minute gap earns nothing. Mail: 90 + 90 + 30 + the last 30.
    const day = (await page.evaluate(
      ([start, end]) => window.api.crmDayActivity(start, end),
      [t0 - 60, t0 + 3_600]
    )) as Block[]
    expect(day.map(({ label, surface, activeSec }) => ({ label, surface, activeSec }))).toEqual([
      { label: 'Quarterly budget', surface: 'Ledger', activeSec: 180 },
      { label: 'Harbour contract', surface: 'Mail', activeSec: 240 }
    ])

    await nav('Day').click()
    for (const label of ['Quarterly budget', 'Harbour contract'])
      await expect(
        page.getByRole('button', { name: new RegExp(`^Open ${label} at .* in Replay$`) })
      ).toHaveCount(1)
    await expect(page.getByRole('meter', { name: 'Ledger' })).toHaveAttribute(
      'aria-valuetext',
      '3m'
    )
    await expect(page.getByRole('meter', { name: 'Mail' })).toHaveAttribute('aria-valuetext', '4m')

    // Reflect reads the same blocks: 7 minutes active.
    const reflection = (await page.evaluate(
      ([start, end]) => window.api.crmDayReflection(start, end),
      [t0 - 60, t0 + 3_600]
    )) as { totalActiveSec: number }
    expect(reflection.totalActiveSec).toBe(420)
    await nav('Reflect').click()
    await expect(page.getByText(/7m\s+active/).first()).toBeVisible()
  })
})
