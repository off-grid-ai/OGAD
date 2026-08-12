/**
 * Tight navigation tour. Piggybacks the screenshot harness's launch/nav pattern
 * (scripts/screenshots.mjs) but ASSERTS each screen + the surfaces this session
 * added, instead of saving PNGs. Runs against a FRESH temp profile (never the
 * real one) and only navigates / reads — no destructive clicks — so it's safe.
 * OFFGRID_PRO=0 forces deterministic free-tier UI.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchOffGrid } from './helpers/launch'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { OFF_GRID_MOBILE_URL } from '../src/renderer/src/constants/links'
import { openSettingsSection } from './helpers/settings'
import { completeOnboarding } from './helpers/onboarding'

let app: ElectronApplication
let page: Page
let userDataDir: string

const nav = async (label: string): Promise<void> => {
  await page.getByRole('button', { name: label, exact: true }).first().click()
  await page.waitForTimeout(500)
}

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-tour-'))
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  // Run with reduced motion so the app's decorative infinite background animation (the
  // .og-shooting-star, which honors prefers-reduced-motion) is disabled — otherwise its
  // perpetual transform keeps the page from ever satisfying Playwright's "stable" check
  // and clicks on section accordions time out.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForLoadState('domcontentloaded')
  // Click through onboarding into the app shell.
  await completeOnboarding(page)
  // Expand the sidebar so nav items have visible labels.
  try {
    await page.getByRole('button', { name: 'Expand sidebar' }).click({ timeout: 4000 })
  } catch {
    /* already open */
  }
  await page.waitForTimeout(500)
})

test.afterAll(async () => {
  await app?.close()
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

test('window and runtime use the canonical desktop product name', async () => {
  await expect(page).toHaveTitle('Off Grid AI Desktop')
  expect(await app.evaluate(({ app: electronApp }) => electronApp.getName())).toBe(
    'Off Grid AI Desktop'
  )
})

test('Models: merged tab + use-cases + import', async () => {
  await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Import \.gguf/i })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Coding', exact: true })).toBeVisible() // use-case chip
})

test('Settings: setup, resource modes, storage, data & privacy all render', async () => {
  await nav('Settings')
  // Sections are collapsed accordions — the titles (headings) are always visible;
  // expand a card to reveal its body before asserting the body content. Only ONE card
  // can be open at a time (SettingsCardsGroup): opening the second section must collapse
  // the first, or the click lands on a card that is exit-animating out of the DOM.
  // openSettingsSection() handles that; do not click the headers directly here.
  await expect(page.getByRole('heading', { name: 'Setup & health' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Data & privacy' })).toBeVisible()

  await openSettingsSection(page, 'Setup & health')
  await expect(page.getByText('Configure it for me')).toBeVisible()
  // The resource-mode selector now lives inside the Configure card.
  for (const m of ['Conservative', 'Balanced', 'Extreme']) {
    // The mode button's accessible name includes its description, so match by substring.
    await expect(page.getByRole('button', { name: m }).first()).toBeVisible()
  }

  await openSettingsSection(page, 'Data & privacy')
  await expect(page.getByText('Screen captures')).toBeVisible()
  await expect(page.getByText('Your data on this device')).toBeVisible()
})

test('Resource mode is selectable (Conservative)', async () => {
  // The modes live in the Setup & health body. A previous test may have left another
  // section open, so always route through the helper rather than probing visibility.
  await openSettingsSection(page, 'Setup & health')
  const cons = page.getByRole('button', { name: 'Conservative' }).first()
  await cons.click()
  await expect(cons).toHaveAttribute('aria-pressed', 'true')
})

test('every locked Pro navigation item renders its matching upgrade screen', async () => {
  // Discover the lock-bearing buttons rendered from the production Pro catalog. This
  // avoids duplicating its route list in the test and fails when a new locked item is
  // added without a working upgrade destination.
  const lockedButtons = page.locator('button').filter({
    has: page.locator('svg title').filter({ hasText: /^Pro$/ })
  })
  const count = await lockedButtons.count()
  expect(count).toBeGreaterThan(2)

  const labels: string[] = []
  for (let index = 0; index < count; index += 1) {
    const button = lockedButtons.nth(index)
    const label = (await button.locator('span.flex-1').innerText()).trim()
    labels.push(label)
    await button.click()
    await expect(page.getByText('Off Grid AI Pro · Available now')).toBeVisible()
    await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible()
  }

  expect(new Set(labels).size).toBe(labels.length)
  expect(await page.evaluate(() => window.api.isPro)).toBe(false)
})

test('purchase and product links open externally without navigating Electron', async () => {
  await page.getByRole('button', { name: 'Replay Pro', exact: true }).click()
  await expect(page.getByText('Off Grid AI Pro · Available now')).toBeVisible()

  const expectedPayUrl = await page.evaluate(() => window.api.license.payUrl())
  const electronUrl = page.url()
  await app.evaluate(({ shell }) => {
    const capture = globalThis as typeof globalThis & { __offgridOpenedExternal?: string[] }
    capture.__offgridOpenedExternal = []
    shell.openExternal = async (url: string): Promise<void> => {
      capture.__offgridOpenedExternal?.push(url)
    }
  })

  await page.getByRole('button', { name: /Get Pro/ }).click()
  await page.getByRole('button', { name: /Get Off Grid AI Mobile/ }).click()

  await expect
    .poll(() =>
      app.evaluate(
        () =>
          (globalThis as typeof globalThis & { __offgridOpenedExternal?: string[] })
            .__offgridOpenedExternal ?? []
      )
    )
    .toEqual([expectedPayUrl, OFF_GRID_MOBILE_URL])
  expect(page.url()).toBe(electronUrl)
})

test('Gateway screen renders', async () => {
  await nav('Settings') // leave the upgrade screen first
  await nav('Gateway')
  await expect(page.getByText(/OpenAI-compatible/i).first()).toBeVisible()
})
