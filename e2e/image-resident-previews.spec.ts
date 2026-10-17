/**
 * With image generation in memory, images come from the resident sd-server, which now shows the
 * image forming at every step, and that server stays loaded through chat while memory allows.
 *
 * Real app; the native boundary is a fake sd-server speaking the sdcpp job API (step previews,
 * then a final image) and a fake llama-server for chat. Image residency is switched on the way a
 * person does it, in Settings → Capture & processing.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { gotoSettings, openSettingsSection } from './helpers/settings'

const IMAGE_MODEL = 'sdxl-lightning-resident.gguf'
const PROMPT = 'A copper lighthouse in a calm sea at dawn, resident preview check'

let app: ElectronApplication | undefined
let page: Page
let profileDir: string
let binDir: string
let serverLog: string

interface ServerEvent {
  event: string
  pid: number
  preview?: string | null
}

const serverEvents = (): ServerEvent[] =>
  fs.existsSync(serverLog)
    ? fs
        .readFileSync(serverLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ServerEvent)
    : []

const closeApp = async (): Promise<void> => {
  if (!app) return
  const child: ChildProcess = app.process()
  await app.close()
  if (child.exitCode === null)
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  app = undefined
}

const enterChat = async (): Promise<void> => {
  const chat = page.getByRole('button', { name: /^Chat$/i }).first()
  await expect(async () => {
    await chat.click()
    await expect(page.locator('textarea')).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible()
}

const generateImage = async (): Promise<void> => {
  // The Image button toggles image mode; turn it on only if it is off.
  const imagePrompt = page.getByPlaceholder('Describe an image to generate…')
  if (!(await imagePrompt.isVisible())) await page.getByRole('button', { name: /^Image$/ }).click()
  await expect(imagePrompt).toBeVisible()
  await page.getByRole('button', { name: /Image options/i }).click()
  await page
    .getByRole('radiogroup', { name: 'Size', exact: true })
    .getByRole('radio', { name: '256', exact: true })
    .click()
  const enhance = page.getByLabel('Enhance')
  if (await enhance.isChecked()) await enhance.uncheck()
  await page.getByPlaceholder('Describe an image to generate…').fill(PROMPT)
  await page.getByTitle('Send').click()
}

test.describe.configure({ mode: 'serial', timeout: 150_000 })

// At file scope, so a packaged run skips before the hooks run (afterEach reads profileDir).
test.skip(targetIsPackaged(), 'This spec controls the source build native image boundary')

test.beforeEach(async () => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-resident-image-'))
  binDir = path.join(profileDir, 'native-boundary')
  serverLog = path.join(profileDir, 'sd-server.jsonl')
  const modelsDir = path.join(profileDir, 'models')
  fs.mkdirSync(path.join(binDir, 'sd'), { recursive: true })
  fs.mkdirSync(path.join(binDir, 'llama'), { recursive: true })
  fs.mkdirSync(modelsDir, { recursive: true })
  for (const [source, target] of [
    ['e2e/fixtures/fake-sd-server.mjs', 'sd/sd-server'],
    ['e2e/fixtures/app093-image-runtime-boundary.mjs', 'sd/sd-cli'],
    ['e2e/fixtures/chat-queue-versions-llama-server.mjs', 'llama/llama-server']
  ]) {
    fs.copyFileSync(path.resolve(source), path.join(binDir, target))
    fs.chmodSync(path.join(binDir, target), 0o755)
  }
  const chatModel = Buffer.alloc(2_048)
  chatModel.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'resident-chat.gguf'), chatModel)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'resident-chat', primary: 'resident-chat.gguf', mmproj: null })
  )
  // A complete SDXL checkpoint by the namespaces production recognises, so it runs resident.
  fs.writeFileSync(
    path.join(modelsDir, IMAGE_MODEL),
    Buffer.from('GGUF first_stage_model conditioner text_encoder vae.'.repeat(80))
  )
  fs.writeFileSync(
    path.join(modelsDir, 'active-modalities.json'),
    JSON.stringify({ image: IMAGE_MODEL })
  )

  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_PRO: '1',
      OFFGRID_BIN_DIR: binDir,
      OFFGRID_FAKE_SD_SERVER_LOG: serverLog,
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
  // Image generation in memory: Settings → Capture & processing.
  await gotoSettings(page)
  await openSettingsSection(page, 'Capture & processing')
  const residency = page.getByRole('switch', { name: 'Image generation residency', exact: true })
  await residency.check()
  await expect(residency).toBeChecked()
  await expect
    .poll(() => page.evaluate(async () => (await window.api.chatHealth()).status))
    .toMatch(/^(ready|idle)$/)
})

test.afterEach(async () => {
  if (fs.existsSync(serverLog)) await test.info().attach('sd-server.jsonl', { path: serverLog })
  await closeApp()
  fs.rmSync(profileDir, { recursive: true, force: true })
})

test('a resident image shows the picture forming before the finished image', async () => {
  await enterChat()
  await generateImage()

  // A step preview shows while the resident server samples, then the finished image replaces it.
  await expect(page.getByRole('img', { name: 'forming', exact: true })).toBeVisible({
    timeout: 30_000
  })
  await expect(page.getByRole('img', { name: 'Generated', exact: true })).toHaveCount(1, {
    timeout: 30_000
  })
  await expect(page.getByRole('img', { name: 'forming', exact: true })).toHaveCount(0)

  // It came from the resident server, which was asked for previews.
  const jobs = serverEvents().filter((entry) => entry.event === 'img_gen')
  expect(jobs).toHaveLength(1)
  expect(jobs[0]!.preview).toBe('proj')
})

test('the in-memory image server stays loaded through a chat turn while memory allows', async () => {
  await enterChat()
  await generateImage()
  await expect(page.getByRole('img', { name: 'Generated', exact: true })).toHaveCount(1, {
    timeout: 45_000
  })
  const started = serverEvents().filter((entry) => entry.event === 'started')
  expect(started).toHaveLength(1)

  // A chat turn in the same window: the image server is not stopped to make room.
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  // A text turn: image mode off.
  if (await page.getByPlaceholder('Describe an image to generate…').isVisible())
    await page.getByRole('button', { name: /^Image$/ }).click()
  await expect(page.getByPlaceholder('Describe an image to generate…')).toBeHidden()
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await composer.fill('Reply with one short word.')
  await composer.press('Enter')
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toBeHidden({
    timeout: 45_000
  })
  // It was a chat turn (no image job), and the image server was not stopped for it.
  expect(serverEvents().filter((entry) => entry.event === 'img_gen')).toHaveLength(1)
  expect(serverEvents().filter((entry) => entry.event === 'stopped')).toEqual([])

  // The next image reuses the same server process instead of starting another.
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await generateImage()
  await expect(page.getByRole('img', { name: 'Generated', exact: true })).toHaveCount(1, {
    timeout: 45_000
  })
  const after = serverEvents()
  expect(after.filter((entry) => entry.event === 'started')).toHaveLength(1)
  expect(after.filter((entry) => entry.event === 'img_gen')).toHaveLength(2)
})
