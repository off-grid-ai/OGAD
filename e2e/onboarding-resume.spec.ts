/**
 * RELEASE_TEST_CHECKLIST #12 - persisted onboarding and interrupted setup work
 * survive a real Electron process relaunch. The interrupted transfer fixture is
 * written at the network/filesystem boundary in the exact registry and partial-
 * file format owned by the production model manager; all recovery reads and UI
 * behavior run through the production app.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchOffGrid } from './helpers/launch'
import type { ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

interface InterruptedFixture {
  modelId: string
  fileName: string
  partial: Buffer
}

let app: ElectronApplication
let page: Page
let userDataDir: string

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

async function launchApp(): Promise<void> {
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_DATA_DIR: userDataDir,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
}

async function finishOnboarding(): Promise<void> {
  for (let step = 0; step < 6; step += 1) {
    const button = page.getByRole('button', { name: /Continue|Start using Off Grid/i })
    if (!(await button.isVisible().catch(() => false))) return
    await button.click()
  }
}

async function closeApp(): Promise<void> {
  const child = app.process()
  await app.close()
  await waitForExit(child)
}

test.beforeEach(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-onboarding-resume-'))
  await launchApp()
})

test.afterEach(async () => {
  if (app?.process().exitCode === null) await app.close()
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('relaunch resumes onboarding progress and one interrupted transfer (#12)', async () => {
  await expect(page.getByRole('heading', { name: 'Off Grid AI' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('onboarding_step'))).toBe('1')
  for (const capability of ['Chat', 'Vision', 'Image', 'Voice', 'Speech', 'Projects']) {
    await expect(page.getByText(capability, { exact: true })).toBeVisible()
  }
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Replay', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('onboarding_step'))).toBe('2')

  await closeApp()
  await launchApp()

  await expect(page.getByText('Replay', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Off Grid AI' })).toHaveCount(0)

  await finishOnboarding()
  await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('onboarding_step'))).toBeNull()
  const modelsDir = await page.evaluate(async () => (await window.api.checkModelStatus()).modelsDir)
  expect(path.resolve(modelsDir).startsWith(path.resolve(userDataDir))).toBe(true)

  await page.getByRole('button', { name: 'Configure', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Set up your local AI' })).toBeVisible()

  const fixture = await page.evaluate(async (): Promise<Omit<InterruptedFixture, 'partial'>> => {
    const [plan, catalog] = await Promise.all([
      window.api.setupPlan('balanced'),
      window.api.getModelCatalog()
    ])
    const selected = plan.items.find((item) => !item.installed) ?? plan.items[0]
    const entry = catalog.models.find((model) => model.id === selected?.id)
    const fileName = entry?.files[0]?.name
    if (!selected || !fileName) throw new Error('Setup plan did not expose a downloadable model')
    return { modelId: selected.id, fileName }
  })
  const interrupted: InterruptedFixture = {
    ...fixture,
    partial: Buffer.from('synthetic partial model payload for relaunch recovery')
  }
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.writeFileSync(path.join(modelsDir, `${interrupted.fileName}.part`), interrupted.partial)
  fs.writeFileSync(
    path.join(modelsDir, 'downloads.json'),
    JSON.stringify([
      {
        modelId: interrupted.modelId,
        status: 'downloading',
        percent: 37,
        currentFile: interrupted.fileName,
        downloadedMB: '1',
        totalMB: '3'
      }
    ])
  )

  await closeApp()
  await launchApp()

  await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Continue|Start using Off Grid/i })).toHaveCount(0)

  const downloads = await page.evaluate(async () => window.api.listDownloads())
  expect(downloads).toEqual([
    expect.objectContaining({
      modelId: interrupted.modelId,
      status: 'failed',
      percent: 37,
      error: 'interrupted - retry to resume'
    })
  ])
  expect(fs.readFileSync(path.join(modelsDir, `${interrupted.fileName}.part`))).toEqual(
    interrupted.partial
  )

  // No expand step: the sidebar opens expanded, so Settings is already reachable by its label and there
  // is no 'Expand sidebar' button to click - it exists only on the collapsed rail.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await page.getByRole('button', { name: /Setup & health/ }).click()

  await expect(page.getByText(interrupted.modelId, { exact: true })).toBeVisible()
  await expect(page.getByText('interrupted - retry to resume', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
  expect(await page.evaluate(async () => (await window.api.listDownloads()).length)).toBe(1)
  expect(fs.readFileSync(path.join(modelsDir, `${interrupted.fileName}.part`))).toEqual(
    interrupted.partial
  )
})
