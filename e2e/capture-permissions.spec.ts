/**
 * Real-app proof for the capture/permission recovery journey. A fresh synthetic profile is the
 * only setup; native macOS permission state is read, not mocked. The shared launcher can target
 * either the local production build or a packaged app with a valid cached E2E license.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { gotoSettings, openSettingsSection, navButton } from './helpers/settings'
import { launchOffGrid, licenseFixtureAvailable, targetIsPackaged } from './helpers/launch'

interface CaptureStatusProjection {
  state:
    | 'capturing'
    | 'paused'
    | 'temporarily-paused'
    | 'permission-required'
    | 'checking-permission'
    | 'stopped'
  pauseReason: 'user' | 'batch' | 'system' | 'privacy' | null
}

let app: ElectronApplication
let page: Page
let userDataDir: string

const expectedCaptureLabel = (status: CaptureStatusProjection): string => {
  switch (status.state) {
    case 'capturing':
      return 'Capturing'
    case 'paused':
      return 'Paused'
    case 'temporarily-paused':
      if (status.pauseReason === 'batch') return 'Re-processing frames'
      if (status.pauseReason === 'system') return 'Paused by macOS'
      return 'Temporarily paused'
    case 'permission-required':
      return 'Permission required'
    case 'checking-permission':
      return 'Checking permission'
    case 'stopped':
      return 'Capture stopped'
  }
}

test.beforeAll(async () => {
  test.skip(
    targetIsPackaged() && !licenseFixtureAvailable(),
    'packaged target requires a cached E2E Pro license'
  )
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-capture-permissions-e2e-'))
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
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
  const proActive = await page.evaluate(() => window.api.isPro === true)
  test.skip(!proActive, 'the selected app target did not activate the cached E2E Pro license')
})

test.afterAll(async () => {
  await app?.close().catch(() => {})
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('Setup & health ends with current permission status and recovery actions', async () => {
  await gotoSettings(page)
  await openSettingsSection(page, 'Setup & health')

  await expect(page.getByText('System permissions')).toBeVisible()
  const permissionSection = page.locator('#settings-permissions')
  for (const name of ['Accessibility', 'Screen Recording', 'Local Network']) {
    await expect(
      permissionSection.getByRole('status', { name: `${name} permission` })
    ).toBeVisible()
  }
  await expect(
    permissionSection.getByRole('button', { name: 'Check permissions again' })
  ).toBeVisible()
  await permissionSection.scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'e2e/screenshots/capture-permissions-settings.png' })
})

test('Replay renders the factual native capture state and routes blocked capture to setup', async () => {
  const replay = navButton(page, 'Replay')
  await replay.click()
  await expect(page.getByRole('heading', { name: 'Replay' })).toBeVisible()

  const status = await page.evaluate(async () => {
    return window.api.proInvoke('capture:status') as Promise<CaptureStatusProjection>
  })
  const capture = page.getByRole('group', { name: 'Capture' })
  await expect(capture).toContainText(expectedCaptureLabel(status))

  if (status.state === 'permission-required') {
    await expect(capture.getByRole('button', { name: 'Pause capture' })).toHaveCount(0)
    await capture.getByRole('button', { name: 'Review permissions' }).click()
    await expect(page.getByText('System permissions')).toBeVisible()
  }
  await page.screenshot({ path: 'e2e/screenshots/capture-permissions-replay.png' })
})
