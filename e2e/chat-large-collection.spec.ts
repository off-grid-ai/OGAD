/**
 * RELEASE_TEST_CHECKLIST #149 - a large persisted chat collection remains
 * searchable, scrollable, and usable in the real desktop master-detail layout.
 * Synthetic records enter through production preload and main-process IPC.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchOffGrid } from './helpers/launch'
import fs from 'fs'
import os from 'os'
import path from 'path'

let app: ElectronApplication
let page: Page
let userDataDir: string

async function finishOnboarding(): Promise<void> {
  for (let step = 0; step < 6; step += 1) {
    const button = page.getByRole('button', { name: /Continue|Start using Off Grid/i })
    if (!(await button.isVisible().catch(() => false))) return
    await button.click()
  }
}

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-chat-collection-'))
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.waitForLoadState('domcontentloaded')
  await finishOnboarding()
  await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible()

  await page.evaluate(async () => {
    for (let index = 1; index <= 120; index += 1) {
      const ordinal = String(index).padStart(3, '0')
      const conversationId = `synthetic-large-chat-${ordinal}`
      await window.api.createRagConversation(conversationId, `Synthetic chat ${ordinal}`, null)
      if (index === 120) {
        await window.api.addRagMessage(
          conversationId,
          'user',
          'Only this conversation contains body-search-needle-120.'
        )
        await window.api.addRagMessage(
          conversationId,
          'assistant',
          'The selected result loaded its persisted message detail.'
        )
      }
    }
  })

  // By role and name, not by title: the sidebar opens EXPANDED, and App.tsx sets
  // title={!sidebarOpen ? item.label : undefined} - the title attribute belongs to the collapsed rail
  // only. An expanded nav carries its label as visible text, so getByTitle waits 30s for an attribute
  // the app is right not to render.
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await expect(page.getByPlaceholder('Search conversations…')).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('120 persisted chats keep search, scroll, and detail usable on desktop (#149)', async () => {
  const rail = page.locator('aside')
  const list = rail.locator('.overflow-y-auto')
  const detail = rail.locator('xpath=following-sibling::div[1]')
  const titles = rail.getByText(/^Synthetic chat \d{3}$/)

  await expect(titles).toHaveCount(120)
  const railBox = await rail.boundingBox()
  const detailBox = await detail.boundingBox()
  expect(railBox).not.toBeNull()
  expect(detailBox).not.toBeNull()
  if (!railBox || !detailBox) return

  const railShare = railBox.width / (railBox.width + detailBox.width)
  expect(railShare).toBeGreaterThan(0.1)
  expect(railShare).toBeLessThan(0.25)
  expect(Math.abs(detailBox.x - (railBox.x + railBox.width))).toBeLessThanOrEqual(2)
  expect(detailBox.width).toBeGreaterThan(railBox.width * 3)

  const search = page.getByPlaceholder('Search conversations…')
  await search.fill('body-search-needle-120')
  await expect(rail.getByText('Synthetic chat 120', { exact: true })).toBeVisible()
  await expect(rail.getByText(/^Synthetic chat \d{3}$/)).toHaveCount(1)

  await rail.getByText('Synthetic chat 120', { exact: true }).click()
  await expect(
    detail.getByText('Only this conversation contains body-search-needle-120.', { exact: true })
  ).toBeVisible()
  await expect(
    detail.getByText('The selected result loaded its persisted message detail.', { exact: true })
  ).toBeVisible()

  await search.fill('')
  await expect(titles).toHaveCount(120)
  const oldest = rail.getByText('Synthetic chat 001', { exact: true })
  await oldest.click()

  const listBox = await list.boundingBox()
  const oldestBox = await oldest.boundingBox()
  expect(listBox).not.toBeNull()
  expect(oldestBox).not.toBeNull()
  if (!listBox || !oldestBox) return
  expect(oldestBox.y).toBeGreaterThanOrEqual(listBox.y)
  expect(oldestBox.y + oldestBox.height).toBeLessThanOrEqual(listBox.y + listBox.height)
  await expect(detail.getByText('Start a conversation', { exact: true })).toBeVisible()
})
