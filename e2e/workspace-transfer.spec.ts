import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'

let app: ElectronApplication
let page: Page
let userData: string

test.beforeAll(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-workspace-transfer-'))
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userData,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  for (let index = 0; index < 6; index += 1) {
    const button = page.getByRole('button', { name: /Continue|Start using Off Grid/i })
    if (!(await button.isVisible().catch(() => false))) break
    await button.click()
  }
  await page
    .getByRole('button', { name: 'Expand sidebar' })
    .click()
    .catch(() => undefined)
  await page
    .getByRole('button', { name: 'Dismiss' })
    .click()
    .catch(() => undefined)
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(userData, { recursive: true, force: true })
})

test('package-owned workspace transfer screen and settings section render in the built app', async () => {
  const summary = await page.evaluate(async () => {
    try {
      return { ok: true as const, value: await window.api.sync.summary() }
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
    }
  })
  expect(summary).toEqual({
    ok: true,
    value: { projects: 0, conversations: 0, messages: 0, documents: 0, attachments: 0 }
  })
  await page.getByRole('button', { name: 'Workspace transfer', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Take your workspace with you.' })).toBeVisible()
  await expect(page.getByLabel('Workspace contents')).toContainText(
    'PROJECTS0CONVERSATIONS0DOCUMENTS0ATTACHMENTS0'
  )
  await expect(page.getByRole('combobox')).toBeDisabled()
  await expect(page.getByRole('option')).toHaveText("Keep this device's version")
  await page.screenshot({ path: 'e2e/screenshots/workspace-transfer.png', fullPage: false })

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Move your Off Grid AI workspace' })).toBeVisible()
})
