/**
 * E2E: the Settings cards fill the width. A wide window lays them out in three columns, or four
 * when the cards this build ships fill four-wide rows better, so no column of cards sits alone.
 * Real built app, free and Pro, fresh temp profiles.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchOffGrid } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'
import { gotoSettings } from './helpers/settings'

test.describe.configure({ timeout: 120_000 })

// Four columns when the last row is fuller four-wide than three-wide (Settings.tsx's rule).
const expectedColumns = (cards: number): number =>
  (cards % 4 || 4) / 4 > (cards % 3 || 3) / 3 ? 4 : 3

async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]!.setSize(size[0]!, size[1]!)
    },
    [width, height]
  )
}

async function layout(page: Page): Promise<{ cards: number; columns: number }> {
  return page.locator('.settings-grid').evaluate((grid) => ({
    cards: [...grid.children].filter(
      (child) => child.getClientRects().length > 0 && !child.classList.contains('col-span-full')
    ).length,
    columns: getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length
  }))
}

for (const pro of ['0', '1']) {
  test(`Settings cards use three or four columns by what ships (Pro=${pro})`, async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-settings-grid-'))
    const app = await launchOffGrid({
      env: {
        ...process.env,
        OFFGRID_USER_DATA: userDataDir,
        OFFGRID_PRO: pro,
        OFFGRID_E2E_HEADLESS: '1',
        NODE_ENV: 'production'
      }
    })
    try {
      const page = await app.firstWindow()
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.waitForLoadState('domcontentloaded')
      await completeOnboarding(page)
      await gotoSettings(page)
      await expect(page.locator('.settings-grid > *').first()).toBeVisible()

      await resize(app, 1900, 1100)
      await expect
        .poll(async () => (await layout(page)).columns)
        .toBe(expectedColumns((await layout(page)).cards))
      // The cards fade in after a resize; capture them settled.
      await expect
        .poll(() =>
          page.evaluate(
            () => document.getAnimations().filter((a) => a.playState === 'running').length
          )
        )
        .toBe(0)
      await page.screenshot({ path: `e2e/screenshots/settings-grid-pro${pro}.png` })

      // A narrower desktop window keeps three columns, whatever ships.
      await resize(app, 1400, 1000)
      await expect.poll(async () => (await layout(page)).columns).toBe(3)
    } finally {
      await app.close().catch(() => undefined)
      fs.rmSync(userDataDir, { recursive: true, force: true })
    }
  })
}
