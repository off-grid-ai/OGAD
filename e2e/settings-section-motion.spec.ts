/**
 * Settings section open/close (accordion drill-in) — behaviour + visible evidence.
 *
 * Guards the SettingsCard motion fix: opening a section used to scale/zoom the card
 * (full framer `layout` animates size via transform: scale(), distorting the text);
 * it is now `layout="position"` so content stays crisp and the body height animation
 * does the vertical growth. A static screenshot can't show the animation's smoothness,
 * but it CAN prove the end states render correctly (crisp, full-width detail, clean
 * return to the grid) and that the drill-in/out behaviour works. Captures collapsed →
 * mid-transition → open → closed into e2e/screenshots/ for the PR + a vision pass.
 *
 * Core build (OFFGRID_PRO=0), fresh temp profile, seeded demo data.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchOffGrid } from './helpers/launch'
import os from 'os'
import path from 'path'
import fs from 'fs'

let app: ElectronApplication
let page: Page
let userDataDir: string

const shot = async (name: string): Promise<void> => {
  await page.screenshot({ path: `e2e/screenshots/${name}.png` })
}

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-settings-motion-'))
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '0',
      OFFGRID_SEED: 'force',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // Dismiss onboarding if present.
  for (let i = 0; i < 8; i++) {
    const btn = page.getByRole('button', { name: /Continue|Start using Off Grid AI/i })
    if (!(await btn.isVisible().catch(() => false))) break
    await btn.click().catch(() => {})
    await page.waitForTimeout(300)
  }
  try {
    await page.getByRole('button', { name: 'Expand sidebar' }).click({ timeout: 4000 })
  } catch {
    /* already open */
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
  await page.waitForTimeout(800)
})

test.afterAll(async () => {
  await app?.close()
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

test('drills into a Settings section and back without distorting the card', async () => {
  // Collapsed grid: several section cards are visible as a scannable master list.
  const setupCard = page.getByRole('button', { name: /Setup & health/ }).first()
  await expect(setupCard).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Setup & health' })).toBeVisible()
  await shot('settings-collapsed')

  // Open it. Capture a mid-transition frame (during the open animation) then the
  // settled detail — so a vision pass can confirm the text is not scaled/zoomed.
  await setupCard.click()
  await page.waitForTimeout(90)
  await shot('settings-opening-midframe')
  await page.waitForTimeout(900)

  // Open state = the L2 detail: a "back to all settings" affordance appears and the
  // card owns the full grid width. The section body content is now visible.
  await expect(page.getByText(/All settings/i).first()).toBeVisible()
  await shot('settings-section-open')

  // The opened card takes the full grid width (col-span-full) — assert it spans most
  // of the viewport, proving the detail morph landed rather than staying a grid cell.
  const openCard = page.getByRole('heading', { name: 'Setup & health' }).locator('..').locator('..')
  const box = await openCard.boundingBox()
  const viewport = page.viewportSize()
  if (box && viewport) {
    expect(box.width).toBeGreaterThan(viewport.width * 0.7)
  }

  // Close it — the back affordance collapses the detail and the grid returns.
  await page
    .getByText(/All settings/i)
    .first()
    .click()
  await page.waitForTimeout(900)
  await expect(page.getByText(/All settings/i)).toHaveCount(0)
  // Sibling sections are back in the grid (drill-out complete).
  await expect(page.getByRole('heading', { name: 'Setup & health' })).toBeVisible()
  await shot('settings-collapsed-again')
})
