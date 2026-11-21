/**
 * The Models screen brings the answer to you: picks for this device lead the Text tab, one click
 * downloads a pick with every file it needs, the finished download becomes the model in use, and
 * "Chat now" opens a chat that answers with it.
 *
 * Real built app and real engine. Only Hugging Face delivery is replaced: each file comes from this
 * machine's own copy (fixtures/model-picks-network-boundary.cjs), so the journey runs on a Mac that
 * already has one pick's files, and skips elsewhere.
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

const SOURCE_DIR =
  process.env.OFFGRID_PICKS_SOURCE_DIR ??
  path.join(os.homedir(), 'Library', 'Application Support', 'Off Grid AI Desktop', 'models')

let app: ElectronApplication | null = null
let page: Page
let profileDir: string

test.skip(targetIsPackaged(), 'The controlled model-host entry point is source-build only.')
test.describe.configure({ timeout: 600_000 })

test.beforeEach(async () => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-model-picks-'))
  app = skipGpuSetup(
    await electron.launch({
      args: [path.resolve('e2e/fixtures/model-picks-network-boundary.cjs')],
      env: {
        ...process.env,
        OFFGRID_USER_DATA: profileDir,
        OFFGRID_PICKS_SOURCE_DIR: SOURCE_DIR,
        OFFGRID_PRO: '0',
        NODE_ENV: 'production',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        GOOGLE_API_KEY: '',
        HF_TOKEN: ''
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

test('a pick for this Mac downloads, becomes the model in use, and Chat now answers with it', async () => {
  await page.getByRole('button', { name: 'Models', exact: true }).click()
  const picks = page.getByRole('list', { name: /^Picks for this / })
  await expect(picks.getByRole('listitem')).toHaveCount(3)
  await expect(picks).toContainText('Fast')
  await expect(picks).toContainText('Balanced')
  await expect(picks).toContainText('Best')
  // The ranking labels the person cannot act on are gone.
  await expect(page.getByText('Challenger', { exact: true })).toHaveCount(0)

  // Use the pick whose every file this machine already has, so no byte crosses the network.
  const catalog = (await page.evaluate(() =>
    (
      window as unknown as { api: { getModelCatalog: () => Promise<unknown> } }
    ).api.getModelCatalog()
  )) as { models: { name: string; files: { name: string }[] }[] }
  let pickName: string | null = null
  for (const item of await picks.getByRole('listitem').all()) {
    const text = (await item.textContent()) ?? ''
    const model = catalog.models.find((entry) => text.includes(entry.name))
    if (
      model?.files.every((file) => fs.existsSync(path.join(SOURCE_DIR, path.basename(file.name))))
    ) {
      pickName = model.name
      break
    }
  }
  test.skip(!pickName, `No pick's files are on this machine in ${SOURCE_DIR}.`)

  const card = picks.getByRole('listitem').filter({ hasText: pickName! })
  await card.getByRole('button', { name: 'Download', exact: true }).click()

  // One click: the download finishes, the model takes over, and the next step is offered.
  const ready = page.getByRole('status').filter({ hasText: `${pickName} is ready.` })
  await expect(ready).toBeVisible({ timeout: 480_000 })
  // Once installed it leaves the picks and stands under the models on this device, in use.
  const installed = page
    .getByRole('list', { name: 'Models on this device' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: pickName!, exact: true }) })
  await expect(installed).toContainText('Active')
  await expect(picks.getByText(pickName!, { exact: true })).toHaveCount(0)
  await page.screenshot({ path: 'e2e/screenshots/model-picks-ready.png' })

  await ready.getByRole('button', { name: 'Chat now' }).click()
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await expect(composer).toBeVisible()
  await composer.fill('What is two plus two? Answer with only the number.')
  await page.keyboard.press('Enter')
  // The model it downloaded answers in the transcript.
  await expect(
    page
      .getByRole('paragraph')
      .filter({ hasText: /^4\.?$/ })
      .last()
  ).toBeVisible({
    timeout: 240_000
  })
  await page.screenshot({ path: 'e2e/screenshots/model-picks-chat-answer.png' })
})
