import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchOffGrid } from './helpers/launch'

let app: ElectronApplication
let page: Page
let userDataDir: string

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-model-control-onboarding-'))
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('explains model location and named Desktop control before setup', async () => {
  const body = page.locator('body')
  await expect(body).toContainText('Local models and your data need no Off Grid AI cloud')

  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(body).toContainText('Choose what runs on your')
  await expect(body).toContainText('run Computer Use with local models')
  await expect(body).toContainText('browse with Web Use')
  await expect(body).toContainText('Add a model server only when you want one')

  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(body).toContainText('Then it starts remembering')
  await expect(body).toContainText('Web Use and Computer Use')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Your devices work as one.')).toBeVisible()
  await expect(body).toContainText('choose a paired Desktop by name')
  await expect(body).toContainText('See and switch the active Chat, Image, Transcription')
  const meshSummary = page.getByText(/Sync your workspace directly/)
  await expect
    .poll(() => meshSummary.evaluate((element) => getComputedStyle(element).opacity))
    .toBe('1')

  const screenshots = path.join(process.cwd(), 'e2e', 'screenshots')
  fs.mkdirSync(screenshots, { recursive: true })
  await page.screenshot({
    path: path.join(screenshots, 'release-107-mobile-model-control.png'),
    fullPage: true
  })

  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('You choose where each model runs.')).toBeVisible()
  await expect(body).toContainText('does not copy server API keys')
})
