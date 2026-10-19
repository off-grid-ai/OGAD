import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'

let app: ElectronApplication
let page: Page
let profile: string
const nav = (name: string): Locator =>
  page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })
async function fits(table: Locator): Promise<void> {
  // Actions and Entities are tables: they fill the content width and never scroll the page sideways.
  await expect(table).toBeVisible()
  const bounds = await table.boundingBox()
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}
async function theme(mode: 'Light' | 'Dark'): Promise<void> {
  const control = page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name: /^Theme:/ })
  for (let i = 0; i < 3 && (await control.getAttribute('aria-label')) !== `Theme: ${mode}`; i++)
    await control.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode.toLowerCase())
}

test.describe('Actions and Entities card journeys', () => {
  test.skip(targetIsPackaged(), 'Source build with a synthetic Pro profile')
  test.beforeAll(async () => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-card-grids-'))
    app = await launchOffGrid({
      env: {
        ...process.env,
        OFFGRID_USER_DATA: profile,
        OFFGRID_E2E_LICENSE_FIXTURE: path.join(profile, 'no-license'),
        OFFGRID_PRO: '1',
        OFFGRID_SEED: 'force',
        OFFGRID_SEED_PRO: 'force',
        NODE_ENV: 'production'
      }
    })
    await app.context().tracing.start({ screenshots: true, snapshots: true })
    page = await app.firstWindow()
    await completeOnboarding(page)
    await page.setViewportSize({ width: 1440, height: 1000 })
  })
  test.afterAll(async () => {
    if (app) {
      await app.context().tracing.stop({ path: test.info().outputPath('cards-trace.zip') })
      await app.close()
    }
    if (profile) fs.rmSync(profile, { recursive: true, force: true })
  })

  test('to-do table retains sorting, source, filters, done, dismiss and restore', async () => {
    await nav('Actions').click()
    const list = page.getByRole('table', { name: 'To-dos', exact: true })
    await fits(list)
    // A to-do's own row; its citation and dismiss form live in the row beneath it.
    const todoRows = list
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: 'Dismiss', exact: true }) })
    const titles = (): Promise<string[]> =>
      list
        .getByRole('button', {
          name: /^(Send the Q3|Reply to Sam|Review Tom|Cut the v0|Approve Maya|Confirm the Helio)/
        })
        .allTextContents()
    const original = await titles()
    expect(original).toHaveLength(6)
    const sort = list.getByRole('columnheader').getByRole('button', { name: 'To do', exact: true })
    await sort.click()
    await expect
      .poll(titles)
      .toEqual([...original].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })))
    await sort.click()
    await expect
      .poll(titles)
      .toEqual([...original].sort((a, b) => b.localeCompare(a, undefined, { sensitivity: 'base' })))
    await sort.click()
    await expect.poll(titles).toEqual(original)
    const board = list.getByRole('row').filter({ hasText: 'Send the Q3 board update' })
    await board.getByRole('button', { name: /^Send the Q3/ }).click()
    await expect(list.getByText('Detected from your communication', { exact: false })).toBeVisible()
    await board.getByRole('button', { name: 'Northwind Capital', exact: true }).click()
    await expect(todoRows).toHaveCount(1)
    await page.getByRole('button', { name: 'Clear filter', exact: true }).click()
    await board.getByRole('button', { name: 'Toggle done' }).click()
    await expect(board).toHaveCount(0)
    await page.getByRole('radio', { name: /^done /i }).click()
    await page
      .getByRole('row')
      .filter({ hasText: 'Send the Q3 board update' })
      .getByRole('button', { name: 'Toggle done' })
      .click()
    await page.getByRole('radio', { name: /^open /i }).click()
    await board.getByRole('button', { name: 'Dismiss', exact: true }).click()
    await list.getByRole('button', { name: 'Cancel', exact: true }).click()
    await board.getByRole('button', { name: 'Dismiss', exact: true }).click()
    await list.getByRole('button', { name: 'Dismiss', exact: true }).last().click()
    await page.getByRole('radio', { name: /^dismissed /i }).click()
    await page
      .getByRole('row')
      .filter({ hasText: 'Send the Q3 board update' })
      .getByRole('button', { name: 'Restore', exact: true })
      .click()
    await page.getByRole('radio', { name: /^open /i }).click()
    await expect(board).toBeVisible()
    await theme('Dark')
    await page.screenshot({ path: test.info().outputPath('actions-dark-wide.png') })
    await theme('Light')
    await page.setViewportSize({ width: 760, height: 900 })
    await fits(list)
    await page.screenshot({ path: test.info().outputPath('actions-light-narrow.png') })
  })

  test('approval table retains details, rejection cancellation and history', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await nav('Actions').click()
    await theme('Light')
    await page.getByRole('radio', { name: /^Approvals/ }).click()
    const list = page.getByRole('table', { name: 'Approvals', exact: true })
    await fits(list)
    const requests = list
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: /details$/ }) })
    await expect(requests).toHaveCount(3)
    const card = list.getByRole('row').filter({ hasText: 'Draft a reply to Sam Okafor' })
    await expect(card.getByRole('button', { name: 'Review in Chat' })).toBeVisible()
    await card.getByRole('button', { name: 'Show details', exact: true }).click()
    // Saved fields read as labelled lines, never as JSON.
    await expect(list.locator('dl')).toBeVisible()
    await expect(list.locator('pre')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(card.getByRole('button', { name: 'Show details', exact: true })).toBeVisible()
    await card.getByRole('button', { name: 'Reject', exact: true }).click()
    await list.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(card.getByRole('button', { name: 'Reject', exact: true })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('approvals-light-wide.png') })
    await page.getByRole('radio', { name: 'History', exact: true }).click()
    await expect(requests).toHaveCount(3)
    await expect(list.getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0)
  })

  test('entity tables retain hierarchy, dossier keyboard access, merge and hide controls', async () => {
    await nav('Entities').click()
    await theme('Light')
    const projects = page.getByRole('table', { name: 'Project entities' })
    await fits(projects)
    const parent = projects
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: 'Open Off Grid AI', exact: true }) })
    await expect(
      page.getByRole('button', { name: 'Open Off Grid AI Mobile', exact: true })
    ).toHaveCount(0)
    await parent.getByRole('button', { name: 'Expand', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Open Off Grid AI Mobile', exact: true })
    ).toBeVisible()
    await parent.getByRole('button', { name: 'Collapse', exact: true }).click()
    await expect(
      page.getByRole('button', { name: 'Open Off Grid AI Mobile', exact: true })
    ).toHaveCount(0)
    const maya = page.getByRole('button', { name: 'Open Maya Chen', exact: true })
    await maya.click()
    await expect(page.getByLabel('Maya Chen dossier', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(maya).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByLabel('Maya Chen dossier', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    const card = page.getByRole('row').filter({ has: maya })
    await card.getByRole('button', { name: 'Merge into another entity' }).click()
    await expect(page.getByPlaceholder('Search the survivor entity…')).toBeVisible()
    await page.keyboard.press('Escape')
    await card.getByRole('button', { name: 'Hide from feed (still captured)' }).click()
    await expect(maya).toHaveCount(0)
    await page.getByRole('button', { name: /^Show archived/ }).click()
    await card.getByRole('button', { name: 'Unhide', exact: true }).click()
    await page.getByRole('button', { name: 'Hide archived', exact: true }).click()
    await expect(maya).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('entities-light-wide.png') })
    await theme('Dark')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 760, height: 900 })
    await fits(projects)
    await page.screenshot({ path: test.info().outputPath('entities-dark-narrow.png') })
  })
  test('tables fit the content width with the sidebar open', async () => {
    const pin = page.getByRole('button', { name: 'Pin sidebar', exact: true })
    if (await pin.isVisible()) await pin.click()
    for (const width of [900, 1600]) {
      await page.setViewportSize({ width, height: 1000 })
      await nav('Entities').click()
      await fits(page.getByRole('table', { name: 'Person entities' }))
      await nav('Actions').click()
      await page.getByRole('radio', { name: /^To do/ }).click()
      await fits(page.getByRole('table', { name: 'To-dos', exact: true }))
      await page.getByRole('radio', { name: /^Approvals/ }).click()
      await fits(page.getByRole('table', { name: 'Approvals', exact: true }))
    }
  })
})
