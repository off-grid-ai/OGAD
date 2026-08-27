/**
 * Packaged-app acceptance test for software-update rollback.
 *
 * No renderer, IPC, updater, database, or network mocks: this launches the packaged
 * application with a fresh synthetic profile and loads the real signed-release list
 * from GitHub through the production main/preload/renderer path. It confirms the
 * selected version reaches electron-updater, then closes before the bundle can finish.
 */
import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_APP = path.resolve(
  'dist/mac-arm64/Off Grid AI Desktop.app/Contents/MacOS/Off Grid AI Desktop'
)
const APP_EXECUTABLE = process.env.OFFGRID_PACKAGED_APP ?? DEFAULT_APP

let app: ElectronApplication
let page: Page
let userDataDir: string

test.beforeAll(async () => {
  test.skip(process.platform !== 'darwin', 'packaged rollback acceptance currently targets macOS')
  test.skip(!fs.existsSync(APP_EXECUTABLE), `packaged app not found at ${APP_EXECUTABLE}`)

  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-update-rollback-'))
  app = await electron.launch({
    executablePath: APP_EXECUTABLE,
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '0',
      OFFGRID_SEED: 'force',
      OFFGRID_SEED_PRO: 'force',
      OFFGRID_ALLOW_UNSIGNED_ARTIFACT: '1',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  for (let step = 0; step < 8; step++) {
    const button = page.getByRole('button', { name: /Continue|Start using Off Grid AI/i })
    if (!(await button.isVisible().catch(() => false))) break
    await button.click()
  }
  await page
    .getByRole('button', { name: 'Expand sidebar' })
    .click({ timeout: 4000 })
    .catch(() => {})
  await page
    .getByRole('button', { name: 'Dismiss' })
    .click({ timeout: 2000 })
    .catch(() => {})
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
  await page.getByRole('heading', { name: 'Software update' }).click()
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('a user can confirm a real signed release and start its exact-version download', async () => {
  await expect(page.getByRole('switch', { name: 'Automatic updates' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Previous versions' })).toBeVisible()

  await page.getByRole('button', { name: 'Previous versions' }).click()
  const releaseButton = page.getByRole('button', { name: /^Use v/ }).first()
  await expect(releaseButton).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Signed releases for this device')).toBeVisible()
  await page.screenshot({ path: 'e2e/screenshots/update-previous-versions.png' })

  const label = await releaseButton.textContent()
  const version = label?.replace(/^Use v/, '')
  expect(version).toBeTruthy()
  await releaseButton.click()

  await expect(page.getByRole('heading', { name: `Install v${version}?` })).toBeVisible()
  await expect(page.getByRole('dialog')).toContainText(`may not open correctly in v${version}`)
  await expect(page.getByText(/Automatic updates will be turned off/)).toBeVisible()
  const downloadButton = page.getByRole('button', { name: `Download v${version}` })
  await expect(downloadButton).toBeVisible()
  await Promise.all(
    [page.locator('[data-slot="dialog-overlay"]'), page.getByRole('dialog')].map((locator) =>
      locator.evaluate((element) =>
        Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished))
      )
    )
  )
  await page.screenshot({ path: 'e2e/screenshots/update-rollback-confirmation.png' })

  await downloadButton.click()
  const downloadStatus = page.getByText(
    `Downloading v${version}. Restart when the update banner appears.`
  )
  await expect(downloadStatus).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Hide previous versions' }).click()
  await expect(page.getByRole('button', { name: 'Previous versions' })).toBeVisible()
  await page.screenshot({ path: 'e2e/screenshots/update-rollback-download-started.png' })
})
