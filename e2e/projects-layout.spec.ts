/**
 * RELEASE_TEST_CHECKLIST #59 - a populated Projects workspace uses the desktop
 * canvas as a dense master-detail surface, with project chats laid out in a
 * multi-column collection. Synthetic records enter through the production IPC
 * handlers and are rendered by the production Electron UI.
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
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-projects-layout-'))
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
    const projectIds: string[] = []
    for (let index = 1; index <= 12; index += 1) {
      const ordinal = String(index).padStart(2, '0')
      const id = await window.api.createProject({
        name: `Synthetic Project ${ordinal}`,
        description: `Synthetic desktop-layout fixture ${ordinal}`
      })
      projectIds.push(id)
    }

    const detailProjectId = projectIds.at(-1)
    if (!detailProjectId) throw new Error('Synthetic project setup failed')
    for (let index = 1; index <= 8; index += 1) {
      const ordinal = String(index).padStart(2, '0')
      await window.api.createRagConversation(
        `synthetic-project-chat-${ordinal}`,
        `Synthetic chat ${ordinal}`,
        detailProjectId
      )
    }
  })

  // By role and name, not by title: the sidebar opens EXPANDED, and App.tsx sets
  // title={!sidebarOpen ? item.label : undefined} - the title attribute belongs to the collapsed rail
  // only. An expanded nav carries its label as visible text, so getByTitle waits 30s for an attribute
  // the app is right not to render.
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()
})

test.afterAll(async () => {
  await app?.close()
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('populated projects stay dense, adjacent, and reachable on a wide desktop (#59)', async () => {
  const heading = page.getByRole('heading', { name: 'Projects' })
  const master = heading.locator('xpath=../..')
  const projectList = master.locator('.overflow-y-auto')
  const detail = master.locator('xpath=following-sibling::div[1]')
  const lastProject = master.getByRole('button', { name: 'Synthetic Project 12' })

  await expect(master.getByRole('button', { name: /^Synthetic Project \d{2}$/ })).toHaveCount(12)
  await lastProject.click()
  await expect(detail.getByText('Synthetic Project 12', { exact: true })).toBeVisible()
  await expect(detail.getByText('8 chats', { exact: true })).toBeVisible()

  const geometry = await Promise.all([
    master.boundingBox(),
    detail.boundingBox(),
    projectList.boundingBox(),
    lastProject.boundingBox()
  ])
  const [masterBox, detailBox, listBox, selectedBox] = geometry
  expect(masterBox).not.toBeNull()
  expect(detailBox).not.toBeNull()
  expect(listBox).not.toBeNull()
  expect(selectedBox).not.toBeNull()
  if (!masterBox || !detailBox || !listBox || !selectedBox) return

  const masterShare = masterBox.width / (masterBox.width + detailBox.width)
  expect(masterBox.width).toBeGreaterThanOrEqual(180)
  expect(masterBox.width).toBeLessThanOrEqual(280)
  expect(masterShare).toBeGreaterThan(0.1)
  expect(masterShare).toBeLessThan(0.22)
  expect(Math.abs(detailBox.x - (masterBox.x + masterBox.width))).toBeLessThanOrEqual(2)
  expect(detailBox.width).toBeGreaterThan(masterBox.width * 3)
  expect(Math.abs(detailBox.height - masterBox.height)).toBeLessThanOrEqual(2)
  expect(selectedBox.x).toBeGreaterThanOrEqual(listBox.x)
  expect(selectedBox.x + selectedBox.width).toBeLessThanOrEqual(listBox.x + listBox.width)
  expect(selectedBox.y).toBeGreaterThanOrEqual(listBox.y)
  expect(selectedBox.y + selectedBox.height).toBeLessThanOrEqual(listBox.y + listBox.height)

  const viewControls = ['Chats', 'Artifacts', 'Knowledge & settings'].map((name) =>
    detail.getByRole('button', { name, exact: true })
  )
  for (const control of viewControls) {
    await expect(control).toBeVisible()
    const box = await control.boundingBox()
    expect(box).not.toBeNull()
    if (!box) continue
    expect(box.x).toBeGreaterThanOrEqual(detailBox.x)
    expect(box.x + box.width).toBeLessThanOrEqual(detailBox.x + detailBox.width)
    expect(box.y).toBeGreaterThanOrEqual(detailBox.y)
  }

  const chatGrid = detail.locator('.grid').first()
  await expect(chatGrid.getByRole('button', { name: /^Synthetic chat \d{2}/ })).toHaveCount(8)
  const columns = await chatGrid.evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns.split(' ').length
  )
  expect(columns).toBeGreaterThanOrEqual(3)

  const gridBox = await chatGrid.boundingBox()
  const firstCardBox = await chatGrid.getByRole('button').first().boundingBox()
  expect(gridBox).not.toBeNull()
  expect(firstCardBox).not.toBeNull()
  if (!gridBox || !firstCardBox) return
  expect(firstCardBox.width).toBeLessThan(gridBox.width / 2)
  expect(firstCardBox.x).toBeGreaterThanOrEqual(detailBox.x)
  expect(firstCardBox.x + firstCardBox.width).toBeLessThanOrEqual(detailBox.x + detailBox.width)
})
