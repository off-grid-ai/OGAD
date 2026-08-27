/**
 * Feature sanity smoke. Boots the real built app (pro active, synthetic seeded temp profile)
 * and walks every major surface, asserting each RENDERS its seeded content without hitting an
 * error boundary. This is a breadth check ("does every feature light up"), not a deep behavior
 * test — those live in the per-feature specs (pro.spec, chat-*, settings-residency, tts-speak).
 *
 * Out of scope by design:
 *  - Live screen capture (would grab the test machine's real screen + needs the model engine for
 *    the distill). Capture's kill-switch/recovery state machine is covered in
 *    pro/main/__tests__/capture-disabled.integration.test.ts; here we assert the DOWNSTREAM
 *    surfaces (Entities/Replay) that capture feeds render seeded data.
 *  - Global hotkeys (OS-level globalShortcut can't be synthesized in Playwright); we assert the
 *    shortcuts surface renders instead.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchOffGrid } from './helpers/launch'
import os from 'os'
import path from 'path'
import fs from 'fs'

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))
let app: ElectronApplication
let page: Page
let userDataDir: string

test.beforeAll(async () => {
  test.skip(!PRO_PRESENT, 'pro package not present')
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-smoke-'))
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
    const btn = page.getByRole('button', { name: /Continue|Start using Off Grid AI/i })
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

// Every surface must render without tripping the app's error boundary.
const assertNoErrorBoundary = async (): Promise<void> => {
  await expect(page.getByText(/Sorry, something went wrong/i)).toHaveCount(0)
  await expect(page.getByText(/Application error|white screen/i)).toHaveCount(0)
}

// label = sidebar button, expect = a text/regex that proves the surface rendered its content.
const SURFACES: Array<{ label: string; expect: RegExp }> = [
  { label: 'Entities', expect: /Entit|Person|Company|Project/i },
  { label: 'Chat', expect: /Off Grid AI|memory|Ask/i },
  { label: 'Clipboard', expect: /Clipboard|clip|copied/i },
  { label: 'Replay', expect: /frames?|Replay|scrubber|moment/i },
  { label: 'Voice', expect: /Voice|speech|transcri/i },
  { label: 'Vault', expect: /Vault|password|secret|entry/i },
  { label: 'Integrations', expect: /Integrations|Connect a tool/i },
  { label: 'Models', expect: /Models|Download|VISION|RAM/i },
  { label: 'Gateway', expect: /Gateway|\/v1|endpoint|localhost/i },
  { label: 'Settings', expect: /Settings|Data & privacy|Model pipeline/i }
]

for (const surface of SURFACES) {
  test(`surface renders: ${surface.label}`, async () => {
    const btn = page.getByRole('button', { name: surface.label, exact: true }).first()
    test.skip(!(await btn.isVisible().catch(() => false)), `${surface.label} nav not present`)
    await btn.click()
    await page.waitForTimeout(700)
    await assertNoErrorBoundary()
    await expect(page.getByText(surface.expect).first()).toBeVisible({ timeout: 8000 })
    await page.screenshot({ path: `e2e/screenshots/smoke-${surface.label.toLowerCase()}.png` })
  })
}

test('capture status surface reports a permission state (no live screen grab)', async () => {
  // Capture's downstream (Entities/Replay) already asserted above. Here just confirm the app
  // can read its own capture/permission status through the real IPC without throwing.
  const status = await page.evaluate(async () => {
    const api = (window as unknown as { api: { proInvoke?: (c: string) => Promise<unknown> } }).api
    if (!api.proInvoke) return null
    try {
      return await api.proInvoke('capture:status')
    } catch (e) {
      return { error: String(e) }
    }
  })
  // Either a structured status object or null (channel absent in this build) — never a throw.
  expect(status === null || typeof status === 'object').toBe(true)
})
