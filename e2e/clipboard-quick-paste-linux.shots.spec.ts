/**
 * The Clipboard screen on GNOME when the app cannot hold the quick paste shortcut, for the PR.
 *
 * A first copy of the app holds Ctrl+Alt+V, so the second one sees what GNOME Wayland shows:
 * the one-step notice that adds the shortcut to the desktop shortcuts. Settings stay in memory
 * (GSETTINGS_BACKEND=memory), so nothing reaches the machine's real desktop shortcuts.
 *
 * Linux only. From the desktop root:
 *   npx electron-vite build
 *   xvfb-run -a npx playwright test clipboard-quick-paste-linux
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchOffGrid } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'

const SHOTS = path.resolve('docs/review/clipboard-linux/screens')
const apps: ElectronApplication[] = []
const profiles: string[] = []

const open = async (): Promise<Page> => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-quick-paste-'))
  profiles.push(profile)
  const app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profile,
      OFFGRID_PRO: '1',
      XDG_CURRENT_DESKTOP: 'GNOME',
      GSETTINGS_BACKEND: 'memory',
      NODE_ENV: 'production'
    }
  })
  apps.push(app)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => window.ogTheme.set('light'))
  await completeOnboarding(page)
  return page
}

const clipboardScreen = async (page: Page): Promise<void> => {
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name: 'Clipboard', exact: true })
    .click()
  await page.waitForTimeout(800)
}

test.afterAll(async () => {
  for (const app of apps.reverse()) await app.close().catch(() => undefined)
  for (const profile of profiles) fs.rmSync(profile, { recursive: true, force: true })
})

test('GNOME: quick paste asks to be added to the desktop shortcuts', async () => {
  test.skip(process.platform !== 'linux', 'The GNOME notice is Linux only')
  test.setTimeout(240_000)
  fs.mkdirSync(SHOTS, { recursive: true })

  const holder = await open()
  await clipboardScreen(holder)
  await expect(holder.getByText(/Add Ctrl\+Alt\+V to your desktop shortcuts/)).toHaveCount(0)
  await holder.screenshot({ path: path.join(SHOTS, 'clipboard-ready.png') })

  const page = await open()
  await clipboardScreen(page)
  await expect(page.getByText(/Add Ctrl\+Alt\+V to your desktop shortcuts/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add shortcut' })).toBeVisible()
  await page.screenshot({ path: path.join(SHOTS, 'clipboard-gnome-notice.png') })
})
