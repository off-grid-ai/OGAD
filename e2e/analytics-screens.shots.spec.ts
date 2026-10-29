/**
 * Light-mode screens of the Analytics surfaces, for the PR.
 *
 * It exists for the design-token pass: AnalyticsPanel, WhatWeShareDialog, ReportProblemDialog
 * and AnalyticsPrompt moved from hand-typed sizes and palette colours to the @offgrid/design
 * tokens. The same spec runs on the branch point and on the change, so the pair is comparable.
 *
 * Nothing is faked: the consent prompt arrives on its real channel from main, the log is the
 * app's own log.
 *
 * Run from the desktop root (it only runs when VIDEO_SHOTS is set, so the e2e suite skips it):
 *   npm run shots -- analytics before
 *   npm run shots -- analytics after
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'
import { gotoSettings, openSettingsSection } from './helpers/settings'

test.describe.configure({ mode: 'serial' })

const PHASE = process.env.VIDEO_SHOTS === 'after' ? 'after' : 'before'
/** Light by default; VIDEO_SHOTS_THEME=dark checks the dark theme, into `-dark` files. */
const THEME = process.env.VIDEO_SHOTS_THEME === 'dark' ? 'dark' : 'light'
const SHOTS = path.resolve('docs/pr-screenshots/release/analytics-video')

let app: ElectronApplication | null = null
let page: Page
let profileDir: string

const shot = async (name: string): Promise<void> => {
  await page.waitForTimeout(500) // let entry motion settle, so before/after differ only in tokens
  await page.screenshot({
    path: path.join(SHOTS, `analytics-${name}-${PHASE}${THEME === 'dark' ? '-dark' : ''}.png`)
  })
}

const closeDialog = async (): Promise<void> => {
  // The corner close, not Escape: a tooltip on the focused button would swallow the first Escape.
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

test.beforeAll(async () => {
  test.skip(!process.env.VIDEO_SHOTS, 'PR screens only: npm run shots -- analytics <phase>')
  test.skip(targetIsPackaged(), 'The screens come from the source build')
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-analytics-shots-'))
  fs.mkdirSync(SHOTS, { recursive: true })
  // A log past the 200,000-character cap, so Report a problem shows its "newest part" note.
  const log = path.join(profileDir, 'diagnostic.log')
  const line = (i: number): string =>
    `${new Date(Date.UTC(2026, 9, 29, 9, 0, i % 60)).toISOString()} info model-server ready port=8${i % 1000} ms=${i % 900}\n`
  fs.writeFileSync(log, Array.from({ length: 4_000 }, (_, i) => line(i)).join(''))
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_DIAGNOSTIC_LOG: log,
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate((theme) => window.ogTheme.set(theme), THEME)
  await completeOnboarding(page)
})

test.afterAll(async () => {
  if (app) {
    const child = app.process()
    await app.close()
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve))
  }
  if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
})

test('Settings > Analytics, What we share and Report a problem', async () => {
  test.setTimeout(120_000)
  await gotoSettings(page)
  await openSettingsSection(page, 'Analytics')
  await expect(page.getByText('Your chats and files never leave your computer.')).toBeVisible()
  await shot('panel')

  await page.getByRole('button', { name: 'What we share' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await shot('what-we-share')
  await closeDialog()

  await page.getByRole('button', { name: 'Report a problem' }).click()
  await expect(page.getByText('Showing the newest part of the log.')).toBeVisible()
  // Focus opens the first button's tooltip over the note; put focus on the log instead.
  await page.getByLabel('Diagnostic log').focus()
  await shot('report-a-problem')
  await closeDialog()
})

test('The consent prompt after a failure', async () => {
  await app!.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send('analytics:prompt', 'failure')
  })
  await expect(page.getByRole('dialog', { name: 'Help us fix this?' })).toBeVisible()
  await shot('failure-prompt')
  await closeDialog()
})
