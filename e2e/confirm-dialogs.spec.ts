/**
 * Confirm prompts are in-app dialogs, so text fields keep taking input after one closes.
 *
 * On Windows, a native window.confirm left inputs unable to take keyboard focus until the window
 * was refocused. The journey runs the real app on a fresh profile with nothing faked: it creates a
 * project, cancels and then confirms its delete, types into a field after the dialog closes, and
 * walks the two-step delete-all prompt without erasing anything.
 */
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchOffGrid } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'
import {
  gotoSettings,
  navButton,
  openSettingsSection,
  settingsSectionHeader
} from './helpers/settings'
import { closeAndWait, mainWindow } from './helpers/windows'

const PROJECT = 'Dialog check'

let app: ElectronApplication
let page: Page
let userDataDir: string

const confirmDialog = (): Locator => page.getByRole('alertdialog')

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-confirm-dialogs-'))
  app = await launchOffGrid({
    env: { OFFGRID_USER_DATA: userDataDir, OFFGRID_PRO: '0', NODE_ENV: 'production' }
  })
  page = await mainWindow(app)
  await completeOnboarding(page)
})

test.afterAll(async () => {
  if (app) await closeAndWait(app)
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('deleting a project asks in the app, and text fields work after the dialog closes', async () => {
  await navButton(page, 'Projects').click()
  await page
    .getByRole('button', { name: /New project/ })
    .last()
    .click()
  await page.keyboard.type(PROJECT)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: PROJECT })).toBeVisible()

  const knowledge = page.getByRole('radio', { name: /knowledge & settings/i })
  if (await knowledge.isVisible()) await knowledge.click()

  await page.getByTitle('Delete project').click()
  await expect(confirmDialog()).toHaveAccessibleName('Delete this project?')
  await confirmDialog().getByRole('button', { name: 'Cancel' }).click()
  await expect(confirmDialog()).toBeHidden()
  await expect(page.getByRole('heading', { name: PROJECT })).toBeVisible()

  const search = page.getByPlaceholder('Find a project')
  await search.click()
  await page.keyboard.type('Dialog')
  await expect(search).toHaveValue('Dialog')
  await search.fill('')

  await page.getByTitle('Delete project').click()
  await confirmDialog().getByRole('button', { name: 'Delete' }).click()
  await expect(confirmDialog()).toBeHidden()
  await expect(page.getByText(PROJECT, { exact: true })).toHaveCount(0)
})

test('delete all data asks twice, and cancelling the second step runs nothing', async () => {
  await gotoSettings(page)
  await openSettingsSection(page, 'Data & privacy')

  await page.getByRole('button', { name: 'Delete all my data', exact: true }).click()
  await expect(confirmDialog()).toHaveAccessibleName('Delete ALL your data?')
  await confirmDialog().getByRole('button', { name: 'Delete all' }).click()

  await expect(confirmDialog()).toHaveAccessibleName('Are you absolutely sure?')
  await confirmDialog().getByRole('button', { name: 'Cancel' }).click()
  await expect(confirmDialog()).toBeHidden()
  // A confirmed delete-all reloads the window, which would close this section.
  await expect(settingsSectionHeader(page, 'Data & privacy')).toHaveAttribute(
    'aria-expanded',
    'true'
  )
})
