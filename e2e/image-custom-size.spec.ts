import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { gotoSettings, openSettingsSection } from './helpers/settings'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'

// A custom width × height typed in the composer reaches the native image runtime as -W/-H.
const IMAGE_MODEL = 'sdxl-lightning-custom-size.gguf'

let app: ElectronApplication | undefined
let page: Page
let profileDir: string
let runtimeLog: string
let evidenceDir: string

test.describe.configure({ mode: 'serial', timeout: 90_000 })

test.beforeEach(async () => {
  test.skip(targetIsPackaged(), 'controls the source build native image-runtime boundary')
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-custom-size-profile-'))
  const binDir = path.join(profileDir, 'native-boundary')
  runtimeLog = path.join(profileDir, 'image-runtime.jsonl')
  evidenceDir = path.join(os.tmpdir(), 'offgrid-custom-size-evidence')
  fs.mkdirSync(path.join(binDir, 'sd'), { recursive: true })
  fs.mkdirSync(path.join(binDir, 'llama'), { recursive: true })
  fs.mkdirSync(path.join(profileDir, 'models'), { recursive: true })
  fs.mkdirSync(evidenceDir, { recursive: true })

  const sdCli = path.join(binDir, 'sd', 'sd-cli')
  fs.copyFileSync(path.resolve('e2e/fixtures/app093-image-runtime-boundary.mjs'), sdCli)
  fs.chmodSync(sdCli, 0o755)
  const llamaServer = path.join(binDir, 'llama', 'llama-server')
  fs.copyFileSync(path.resolve('e2e/fixtures/chat-queue-versions-llama-server.mjs'), llamaServer)
  fs.chmodSync(llamaServer, 0o755)
  const chatModel = Buffer.alloc(2_048)
  chatModel.write('GGUF')
  fs.writeFileSync(path.join(profileDir, 'models', 'custom-size-chat.gguf'), chatModel)
  fs.writeFileSync(
    path.join(profileDir, 'models', 'active-model.json'),
    JSON.stringify({ id: 'custom-size-chat', primary: 'custom-size-chat.gguf', mmproj: null })
  )
  fs.writeFileSync(
    path.join(profileDir, 'models', IMAGE_MODEL),
    Buffer.from('GGUF first_stage_model conditioner text_encoder vae.'.repeat(80))
  )
  fs.writeFileSync(
    path.join(profileDir, 'models', 'active-modalities.json'),
    JSON.stringify({ image: IMAGE_MODEL })
  )

  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_PRO: '1',
      OFFGRID_BIN_DIR: binDir,
      APP093_IMAGE_RUNTIME_LOG: runtimeLog,
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
  // The one-shot CLI owns this run, so its arguments land in the runtime log.
  await gotoSettings(page)
  await openSettingsSection(page, 'Capture & processing')
  await page.getByRole('switch', { name: 'Image generation residency', exact: true }).uncheck()
})

// Playwright requires a destructured first parameter.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  if (app) {
    await app.close()
    app = undefined
  }
  if (fs.existsSync(runtimeLog))
    fs.copyFileSync(runtimeLog, testInfo.outputPath('image-runtime.jsonl'))
  fs.rmSync(profileDir, { recursive: true, force: true })
})

test('a custom width × height reaches the image runtime', async () => {
  const chat = page.getByRole('button', { name: /^Chat$/i }).first()
  await expect(async () => {
    await chat.click()
    await expect(page.locator('textarea')).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  const dismissSetup = page.getByRole('button', { name: 'Dismiss', exact: true })
  if (await dismissSetup.isVisible().catch(() => false)) await dismissSetup.click()
  await page.getByRole('button', { name: 'New chat', exact: true }).click()

  await page.getByRole('button', { name: /^Image$/ }).click()
  await page.getByRole('button', { name: /Image options/i }).click()
  await page
    .getByRole('radiogroup', { name: 'Size', exact: true })
    .getByRole('radio', { name: 'Custom', exact: true })
    .click()
  const width = page.getByLabel('Image width', { exact: true })
  await width.fill('1200')
  await width.press('Enter')
  await expect(width).toHaveValue('1216')
  const height = page.getByLabel('Image height', { exact: true })
  await height.fill('832')
  await height.press('Enter')
  await page.getByRole('slider', { name: 'Steps', exact: true }).press('Home')
  const enhance = page.getByLabel('Enhance')
  if (await enhance.isChecked()) await enhance.uncheck()
  await page.screenshot({ path: path.join(evidenceDir, 'composer-custom-size-light.png') })

  await page.getByPlaceholder('Describe an image to generate…').fill('A wide desert road at dusk')
  await page.getByTitle('Send').click()
  await expect(page.getByRole('img', { name: 'Generated', exact: true })).toHaveCount(1, {
    timeout: 15_000
  })

  const start = fs
    .readFileSync(runtimeLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { event: string; args: string[] })
    .find(({ event }) => event === 'start')!
  expect(start.args[start.args.indexOf('-W') + 1]).toBe('1216')
  expect(start.args[start.args.indexOf('-H') + 1]).toBe('832')
})
