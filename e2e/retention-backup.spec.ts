/**
 * Archive-before-delete surface (Settings > Data & privacy): the "Back up first"
 * toggle exists for exactly the file-centric categories, arms visibly, and the
 * summary reflects seeded capture files. Fresh temp profile; UI-state clicks only -
 * the actual archive flow opens a native save dialog, which is covered by the
 * unit/integration tests (retention-archive.test.ts), not driven here.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchOffGrid } from './helpers/launch'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { openSettingsSection } from './helpers/settings'
import { completeOnboarding } from './helpers/onboarding'

let app: ElectronApplication
let page: Page
let userDataDir: string

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-retention-'))
  // Seed a few old capture files so the captures row has data and enabled buttons.
  const captures = path.join(userDataDir, 'captures')
  fs.mkdirSync(captures, { recursive: true })
  const old = new Date(Date.now() - 10 * 86_400_000)
  for (const name of ['capture-1.png', 'capture-2.png', 'capture-3.png']) {
    const p = path.join(captures, name)
    fs.writeFileSync(p, 'fake-png-bytes')
    fs.utimesSync(p, old, old)
  }
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('Back up first is offered for file categories and arms visibly', async () => {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
  await openSettingsSection(page, 'Data & privacy')
  await expect(page.getByText('Your data on this device')).toBeVisible()

  // Exactly the archivable categories offer the toggle; chats does not.
  await expect(
    page.getByRole('button', { name: 'Back up Screen captures before deleting' })
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Back up Meetings before deleting' })
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Back up Generated images & artifacts before deleting' })
  ).toBeVisible()
  await expect(page.getByRole('button', { name: /Back up Chats/ })).toHaveCount(0)

  // Seeded captures show up in the summary (3 files).
  await expect(page.getByText(/3 items/)).toBeVisible()

  // Arm the toggle for captures - pressed state flips (pure UI state, no delete).
  const toggle = page.getByRole('button', { name: 'Back up Screen captures before deleting' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')

  await page.screenshot({ path: 'e2e/screenshots/retention-backup-panel.png' })
})

test('Automatic cleanup arms from Off and reveals folder + Run now', async () => {
  await expect(page.getByText('Automatic cleanup')).toBeVisible()
  const off = page.getByRole('button', { name: 'Off', exact: true })
  await expect(off).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: /run now/i })).toHaveCount(0)

  await page.getByRole('button', { name: '30 days', exact: true }).click()
  await expect(page.getByRole('button', { name: '30 days', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(page.getByText(/no backup - choose a folder/i)).toBeVisible()
  await expect(page.getByRole('button', { name: /run now/i })).toBeVisible()

  await page.screenshot({ path: 'e2e/screenshots/retention-auto-cleanup.png' })
})
