import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { launchOffGrid } from './helpers/launch'
import type { ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  lockedResidencyRows,
  residencyStatusText,
  residencySwitchLabel,
  unlockedResidencyRows
} from '../src/renderer/src/lib/residency-rows'
import { gotoSettings, openSettingsSection } from './helpers/settings'
import { completeOnboarding } from './helpers/onboarding'

let app: ElectronApplication | null = null
let page: Page
let userDataDir: string

const launchApp = async (): Promise<void> => {
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  // Reduced motion disables the decorative infinite background animation, whose perpetual
  // transform otherwise keeps the page from ever satisfying Playwright's "stable" check
  // (same reason tour.spec.ts does this).
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForLoadState('domcontentloaded')
}

const waitForExit = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) return
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

const closeApp = async (): Promise<void> => {
  const running = app
  if (!running) return
  app = null
  const child = running.process()
  await running.close()
  await waitForExit(child)
}

// "Model memory" is an <h4> inside the Capture & processing section body — not a button and
// not a top-level section. Reaching it means opening that section first.
const openModelMemory = async (): Promise<void> => {
  await gotoSettings(page)
  await openSettingsSection(page, 'Capture & processing')
  await expect(page.getByText('Model memory', { exact: true })).toBeVisible()
}

const persistedResidency = async (): Promise<Record<string, string>> =>
  page.evaluate(() => window.api.residencyGet())

const residencySwitch = (label: string): Locator =>
  page.getByRole('switch', { name: residencySwitchLabel({ label }) })

// Selectors are DERIVED from RESIDENCY_ROWS, the module the UI renders from. Re-hardcoding
// the names here is what let them drift out of sync with the app (the spec asked for
// 'Chat model residency' while the UI rendered 'Chat and capture model residency').
const residencyControls = (): {
  chat: Locator
  unlocked: Locator[]
} => ({
  chat: residencySwitch(lockedResidencyRows()[0].label),
  unlocked: unlockedResidencyRows().map((row) => residencySwitch(row.label))
})

const expectedResidentState = (): Record<string, string> =>
  Object.fromEntries(
    [...lockedResidencyRows(), ...unlockedResidencyRows()].map((row) => [row.modality, 'resident'])
  )

test.beforeEach(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-residency-e2e-'))
  await launchApp()
  await completeOnboarding(page)
})

test.afterEach(async () => {
  await closeApp()
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('runtime residency controls persist across relaunch while chat stays required', async () => {
  await openModelMemory()

  const { chat } = residencyControls()
  await expect(chat).toBeChecked()
  await expect(chat).toBeDisabled()
  await expect(page.getByText(residencyStatusText({ locked: true }, true))).toBeVisible()

  // a89c70dc8 added grounding and embeddings with in-memory defaults.
  // Check those defaults, then exercise off -> on for every editable control.
  for (const row of unlockedResidencyRows()) {
    const control = residencySwitch(row.label)
    const startsResident = row.modality === 'grounding' || row.modality === 'embeddings'
    await expect(control).toBeChecked({ checked: startsResident })
    if (startsResident) await control.click()
    await expect(control).not.toBeChecked()
    await control.click()
    await expect(control).toBeChecked()
  }

  await expect.poll(persistedResidency).toEqual(expectedResidentState())

  await closeApp()
  await launchApp()
  await openModelMemory()

  const relaunched = residencyControls()
  await expect(relaunched.chat).toBeChecked()
  await expect(relaunched.chat).toBeDisabled()
  for (const control of relaunched.unlocked) await expect(control).toBeChecked()
  await expect(persistedResidency()).resolves.toEqual(expectedResidentState())
})
