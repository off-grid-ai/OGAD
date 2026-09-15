import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchOffGrid } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'
import { gotoSettings, openSettingsSection } from './helpers/settings'

let app: ElectronApplication
let page: Page
let userDataDir: string

const visibleLayoutWidth = (): Promise<number> =>
  page.evaluate(() => document.documentElement.clientWidth)
const zoomModifier = process.platform === 'darwin' ? 'Meta' : 'Control'

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-zoom-shortcuts-'))
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
  await expect(page.locator('#root')).not.toBeEmpty()
  await completeOnboarding(page)
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('desktop zoom shortcuts are complete and persist across restart', async () => {
  const initialWidth = await visibleLayoutWidth()

  await page.keyboard.press(`${zoomModifier}+=`)
  await expect.poll(visibleLayoutWidth).toBeLessThan(initialWidth)

  await page.keyboard.press(`${zoomModifier}+-`)
  await expect.poll(visibleLayoutWidth).toBe(initialWidth)

  await page.keyboard.press(`${zoomModifier}+=`)
  const zoomedWidth = await visibleLayoutWidth()
  await app.close()

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
  await expect(page.locator('#root')).not.toBeEmpty()
  await expect.poll(visibleLayoutWidth).toBe(zoomedWidth)

  await page.keyboard.press(`${zoomModifier}+0`)
  await expect.poll(visibleLayoutWidth).toBe(initialWidth)

  await gotoSettings(page)
  await openSettingsSection(page, 'Keyboard shortcuts')
  await expect(page.getByText('Window zoom', { exact: true })).toBeVisible()
  await expect(page.getByText('+ / - / 0', { exact: true })).toBeVisible()
})
