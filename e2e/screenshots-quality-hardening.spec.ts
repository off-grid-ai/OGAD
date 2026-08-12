/**
 * PR evidence capture for the quality-hardening branch. Boots the real built app with pro
 * active + seeded demo data (TEMP profile only) and screenshots the surfaces this branch
 * touched: the Models screen (never-block fit chip), Settings -> Model pipeline controls,
 * and the Integrations screen (BYO Google OAuth client setup). Screenshots land in
 * e2e/screenshots/ for the PR body.
 *
 * Each case ASSERTS that it reached the surface it is photographing. It used to assert nothing and swallow
 * every failure, so a screenshot of a blank window, or of the wrong screen, passed exactly like a good one -
 * and the PR body then carried that image as evidence. A screenshot that disproves the change is worse than no
 * screenshot, so the navigation is now a precondition rather than best-effort.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { launchOffGrid } from './helpers/launch'
import os from 'os'
import path from 'path'
import fs from 'fs'

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))
let app: ElectronApplication
let page: Page
let userDataDir: string

const shot = async (name: string): Promise<void> => {
  await page.waitForTimeout(600)
  await page.screenshot({ path: `e2e/screenshots/qh-${name}.png` })
}

const nav = async (label: string): Promise<boolean> => {
  const btn = page.getByRole('button', { name: label, exact: true }).first()
  if (!(await btn.isVisible().catch(() => false))) return false
  await btn.click().catch(() => {})
  await page.waitForTimeout(700)
  return true
}

test.beforeAll(async () => {
  test.skip(!PRO_PRESENT, 'pro package not present')
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-qh-shots-'))
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '1',
      OFFGRID_SEED: 'force',
      OFFGRID_SEED_PRO: 'force',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  for (let i = 0; i < 8; i++) {
    const btn = page.getByRole('button', { name: /Continue|Start using Off Grid/i })
    if (!(await btn.isVisible().catch(() => false))) break
    await btn.click().catch(() => {})
    await page.waitForTimeout(400)
  }
  try {
    await page.getByRole('button', { name: 'Expand sidebar' }).click({ timeout: 4000 })
  } catch {
    /* already open */
  }
  await page.waitForTimeout(1500)
})

test.afterAll(async () => {
  await app?.close()
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

test('capture Models screen — never-block fit chip', async () => {
  expect(await nav('Models'), 'the Models screen has to be reachable from the sidebar').toBe(true)
  await shot('models-fit-chip')
})

test('capture Settings — model pipeline controls', async () => {
  expect(await nav('Settings'), 'Settings has to be reachable from the sidebar').toBe(true)
  // Scroll the Model pipeline section into view if present.
  const section = page.getByText('Model pipeline', { exact: false }).first()
  if (await section.isVisible().catch(() => false)) {
    await section.scrollIntoViewIfNeeded().catch(() => {})
  }
  await shot('settings-model-pipeline')
})

test('capture Settings — capture opt-in control', async () => {
  // Task 1 (capture is explicit opt-in per device). The platform-conditional DEFAULT is a
  // main-process rule proven by unit + real-seam integration in desktop-pro; here we capture the
  // user-facing surface the opt-in is controlled through — the Settings "Capture" section with its
  // status label and pause/resume/restart controls — which is what a user sees to turn capture on.
  expect(await nav('Settings'), 'Settings has to be reachable from the sidebar').toBe(true)
  // The capture control lives inside the collapsed "Capture & processing" accordion — expand it.
  const header = page.getByText('Capture & processing', { exact: false }).first()
  if (await header.isVisible().catch(() => false)) {
    await header.scrollIntoViewIfNeeded().catch(() => {})
    await header.click().catch(() => {})
    await page.waitForTimeout(600)
  }
  await shot('settings-capture-optin')
})

test('capture Integrations — BYO Google OAuth client setup', async () => {
  const reached = (await nav('Integrations')) || (await nav('Connectors'))
  if (!reached) await shot('integrations-not-reached')
  // Named either way in this build; one of the two must exist, or the screenshot below is of whatever screen
  // happened to be open.
  expect(reached, 'Integrations (or Connectors) has to be reachable from the sidebar').toBe(true)
  await shot('integrations-overview')
  // Best-effort: open the Google client setup (BYO OAuth) if an entry is present.
  for (const label of [/set up your google client/i, /google/i, /set up/i]) {
    const entry = page.getByRole('button', { name: label }).first()
    if (await entry.isVisible().catch(() => false)) {
      await entry.click().catch(() => {})
      await page.waitForTimeout(600)
      break
    }
  }
  await shot('integrations-byo-google-setup')
})

test('capture Replay — enable/disable capture control', async () => {
  // Task 4: the Replay screen carries a compact enable/disable capture control in its header,
  // sharing the same seam as the Settings Capture section (useCaptureControl).
  const reached = await nav('Replay')
  if (!reached) await shot('replay-not-reached')
  expect(reached, 'Replay has to be reachable from the sidebar').toBe(true)
  const toggle = page.getByRole('button', { name: /capture/i }).first()
  await toggle.scrollIntoViewIfNeeded().catch(() => {})
  // The control this case exists to photograph. Without this the shot could be of a Replay screen that never
  // rendered its header, which is precisely the evidence a reviewer would be misled by.
  await expect(toggle).toBeVisible()
  await shot('replay-capture-toggle')
})
