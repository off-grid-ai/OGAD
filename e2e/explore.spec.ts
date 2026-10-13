/**
 * Explore catalog - the capability-panel catalog renders in the chat empty state and
 * each card opens its intake form before anything runs. Free build, fresh profile - the catalog needs no model and no seed.
 *
 * Screenshots land in e2e/screenshots/ for PR evidence.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchOffGrid } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'
import os from 'os'
import path from 'path'
import fs from 'fs'

let app: ElectronApplication
let page: Page
let userDataDir: string

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-e2e-explore-'))
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
  try {
    await page.getByRole('button', { name: 'Expand sidebar' }).click({ timeout: 4000 })
  } catch {
    /* already open */
  }
})

test.afterAll(async () => {
  await app?.close()
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

// The standalone Explore screen was removed when God replaced it (416cea1c6); the catalog now
// lives in the chat empty state, so its cards are exercised there.
test('catalog cards in the chat empty state open their intake form before a run starts', async () => {
  for (const presetId of ['best-nearby', 'price-compare']) {
    await page.getByRole('button', { name: 'Chat', exact: true }).first().click()
    await page.getByRole('button', { name: 'New chat', exact: true }).click()
    const card = page.getByTestId(`explore-preset-${presetId}`)
    await expect(card).toBeVisible()
    // A card carries its label + blurb; the seeded prompt stays behind the tap.
    await card.click()
    await expect(page.getByTestId(`preset-intake-${presetId}`)).toBeVisible()
  }
})

test('the chat empty state reuses the same catalog with its compact intro', async () => {
  await page.getByRole('button', { name: 'Chat', exact: true }).first().click()
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(page.getByText('Explore what Off Grid AI can do')).toBeVisible()
  await expect(page.getByTestId('explore-preset-best-nearby')).toBeVisible()
  await page.screenshot({ path: 'e2e/screenshots/explore-chat-empty.png' })
})
