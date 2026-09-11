import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchOffGrid } from './helpers/launch'

let app: ElectronApplication
let page: Page
let userDataDir: string

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-app-launch-'))
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('the first window renders and startup settles without blocking it', async () => {
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('#root')).not.toBeEmpty()
  await expect(
    page.getByText('Off Grid AI Desktop could not finish startup. Restart the app.')
  ).toHaveCount(0)
  await expect(page.getByText(/did not finish|took longer than expected/)).toHaveCount(0, {
    timeout: 15_000
  })
})
