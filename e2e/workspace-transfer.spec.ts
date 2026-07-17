import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'

let app: ElectronApplication
let page: Page
let userData: string

async function waitForAnimatedAncestors(anchor: Locator): Promise<void> {
  await expect
    .poll(
      () =>
        anchor.evaluate((element) => {
          let current = element.parentElement
          let found = false
          while (current) {
            const ownsAnimationState =
              current.style.opacity !== '' ||
              current.style.filter !== '' ||
              current.style.transform !== ''
            if (ownsAnimationState) {
              found = true
              const style = getComputedStyle(current)
              const blur = style.filter.match(/blur\(([^)]+)\)/)?.[1]
              const hasBlur = blur !== undefined && Number.parseFloat(blur) !== 0
              const hasTransform = current.style.transform !== '' && style.transform !== 'none'
              if (style.opacity !== '1' || hasBlur || hasTransform) {
                return { found, settled: false }
              }
            }
            current = current.parentElement
          }
          return { found, settled: found }
        }),
      {
        message: 'animated content ancestors should finish opacity, blur, and transform transitions'
      }
    )
    .toEqual({ found: true, settled: true })
}

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
  const expandSidebar = page.getByRole('button', { name: 'Expand sidebar' })
  if (await expandSidebar.isVisible()) await expandSidebar.click()
  const dismiss = page.getByRole('button', { name: 'Dismiss' })
  if (await dismiss.isVisible()) await dismiss.click()
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
  const workspaceHeading = page.getByRole('heading', { name: 'Take your workspace with you.' })
  await expect(workspaceHeading).toBeVisible()
  await waitForAnimatedAncestors(workspaceHeading)
  await expect(page.getByLabel('Workspace contents')).toContainText(
    'PROJECTS0CONVERSATIONS0DOCUMENTS0ATTACHMENTS0'
  )
  await expect(page.getByRole('combobox')).toBeDisabled()
  await expect(page.getByRole('option')).toHaveText('Keep existing')
  await page.screenshot({ path: 'e2e/screenshots/workspace-transfer.png', fullPage: false })

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settingsHeading = page.getByRole('heading', { name: 'Move your Off Grid AI workspace' })
  await expect(settingsHeading).toBeVisible()
  await settingsHeading.scrollIntoViewIfNeeded()
  await expect(settingsHeading).toBeInViewport()
  await waitForAnimatedAncestors(settingsHeading)
  const settingsSection = page.getByRole('region', { name: 'Move your Off Grid AI workspace' })
  await expect(settingsSection.getByRole('button', { name: 'Export workspace' })).toBeVisible()
  await expect(settingsSection.getByRole('button', { name: 'Import workspace' })).toBeVisible()
  await expect
    .poll(() => settingsSection.evaluate((section) => section.scrollWidth <= section.clientWidth))
    .toBe(true)
  await settingsSection.screenshot({ path: 'e2e/screenshots/workspace-transfer-settings.png' })
})
