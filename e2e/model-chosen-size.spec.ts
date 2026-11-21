/**
 * The size picked in a model's panel is the size that loads. Real built app, real Hugging Face
 * file list; only the file bytes are small stand-ins (fixtures/model-picks-network-boundary.cjs).
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { targetIsPackaged, skipGpuSetup } from './helpers/launch'

let app: ElectronApplication | null = null
let page: Page
let profileDir: string

test.skip(targetIsPackaged(), 'The controlled model-host entry point is source-build only.')
test.describe.configure({ timeout: 240_000 })

test.beforeEach(async () => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-chosen-size-'))
  app = skipGpuSetup(
    await electron.launch({
      args: [path.resolve('e2e/fixtures/model-picks-network-boundary.cjs')],
      env: {
        ...process.env,
        OFFGRID_USER_DATA: profileDir,
        OFFGRID_PICKS_SOURCE_DIR: profileDir,
        OFFGRID_PICKS_STANDIN: '1',
        OFFGRID_PRO: '0',
        NODE_ENV: 'production'
      }
    })
  )
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
})

test.afterEach(async () => {
  const running = app
  app = null
  await running?.close()
  fs.rmSync(profileDir, { recursive: true, force: true })
})

test('downloading the Smaller size of a model makes that size the one in use', async () => {
  await page.getByRole('button', { name: 'Models', exact: true }).click()
  // A chat model none of whose files is pinned to a SHA-256: the stand-in bytes cannot match a pin.
  const catalog = (await page.evaluate(() =>
    (
      window as unknown as { api: { getModelCatalog: () => Promise<unknown> } }
    ).api.getModelCatalog()
  )) as {
    models: { name: string; kind: string; replacedBy?: string; files: { sha256?: string }[] }[]
  }
  const model = catalog.models.find(
    (entry) =>
      (entry.kind === 'vision' || entry.kind === 'text') &&
      !entry.replacedBy &&
      entry.files.length > 0 &&
      entry.files.every((file) => !file.sha256)
  )
  test.skip(!model, 'No chat model without pinned files')
  await page.getByRole('button', { name: model!.name, exact: true }).first().click()
  const panel = page.getByRole('dialog', { name: `${model!.name} details` })
  const sizes = panel.getByRole('region', { name: 'Available model files' })
  const smaller = sizes.locator('div.rounded').filter({ hasText: 'Smaller' }).first()
  await expect(smaller).toBeVisible({ timeout: 60_000 })
  const fileName = (await smaller.locator('p').last().textContent())!.trim()
  expect(fileName).toMatch(/\.gguf$/)
  await smaller.getByRole('button', { name: `Download ${fileName}` }).click()

  await expect(page.getByRole('status').filter({ hasText: 'is ready.' })).toBeVisible({
    timeout: 120_000
  })
  const active = JSON.parse(
    fs.readFileSync(path.join(profileDir, 'models', 'active-model.json'), 'utf8')
  ) as { primary: string }
  expect(active.primary).toBe(fileName)
  await page.screenshot({ path: 'e2e/screenshots/model-chosen-size-active.png' })
})
