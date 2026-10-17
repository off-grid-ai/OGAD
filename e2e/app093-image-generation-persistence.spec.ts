import { gotoSettings, openSettingsSection } from './helpers/settings'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'

const IMAGE_MODEL = 'sdxl-lightning-app093.gguf'
const PROMPT = 'A single emerald lighthouse on a midnight island — APP093'

let app: ElectronApplication | undefined
let page: Page
let profileDir: string
let boundaryBinDir: string
let runtimeLog: string
let evidenceDir: string

const waitForExit = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) return
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

const closeApp = async (): Promise<void> => {
  if (!app) return
  const child = app.process()
  await app.close()
  await waitForExit(child)
  app = undefined
}

const launch = async (): Promise<void> => {
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_PRO: '1',
      OFFGRID_BIN_DIR: boundaryBinDir,
      APP093_IMAGE_RUNTIME_LOG: runtimeLog,
      OFFGRID_CHAT_CONTROLS_AUDIT_FILE: path.join(profileDir, 'chat-runtime.jsonl'),
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
  // This journey owns the one-shot CLI process, including its cancellation and PNG output.
  await gotoSettings(page)
  await openSettingsSection(page, 'Capture & processing')
  await page.getByRole('switch', { name: 'Image generation residency', exact: true }).uncheck()
  // Let this profile own its model port before image eviction. Another running
  // Desktop instance can keep its real model on the default port.
  // Models load on first use (c6a2d9f72): a healthy app at launch is ready or idle.
  await expect
    .poll(() => page.evaluate(async () => (await window.api.chatHealth()).status))
    .toMatch(/^(ready|idle)$/)
}

const enterChat = async (newChat = false): Promise<void> => {
  const chat = page.getByRole('button', { name: /^Chat$/i }).first()
  await expect(chat).toBeVisible()
  await expect(async () => {
    await chat.click()
    await expect(page.locator('textarea')).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  const dismissSetup = page.getByRole('button', { name: 'Dismiss', exact: true })
  if (await dismissSetup.isVisible().catch(() => false)) await dismissSetup.click()
  if (newChat) {
    await page.getByRole('button', { name: 'New chat', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible()
  }
}

const scopedImages = async (): Promise<{
  conversationId: string
  images: Array<{ path: string; name: string; conversationId?: string }>
}> =>
  page.evaluate(async () => {
    const conversations = await window.api.getRagConversations(null)
    const conversationId = conversations[0]?.id as string
    const images = await window.api.listGeneratedImages({ conversationId })
    return { conversationId, images }
  })

test.describe.configure({ mode: 'serial', timeout: 90_000 })

test.beforeEach(async () => {
  test.skip(targetIsPackaged(), 'APP-093 controls the source build native image-runtime boundary')
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-app093-profile-'))
  boundaryBinDir = path.join(profileDir, 'app093-native-boundary')
  runtimeLog = path.join(profileDir, 'app093-image-runtime.jsonl')
  evidenceDir = path.join(os.tmpdir(), 'offgrid-app093-evidence')
  fs.mkdirSync(path.join(boundaryBinDir, 'sd'), { recursive: true })
  fs.mkdirSync(path.join(boundaryBinDir, 'llama'), { recursive: true })
  fs.mkdirSync(path.join(profileDir, 'models'), { recursive: true })
  fs.mkdirSync(evidenceDir, { recursive: true })

  const boundarySource = path.resolve('e2e/fixtures/app093-image-runtime-boundary.mjs')
  const boundaryExecutable = path.join(boundaryBinDir, 'sd', 'sd-cli')
  fs.copyFileSync(boundarySource, boundaryExecutable)
  fs.chmodSync(boundaryExecutable, 0o755)
  const chatExecutable = path.join(boundaryBinDir, 'llama', 'llama-server')
  fs.copyFileSync(path.resolve('e2e/fixtures/chat-queue-versions-llama-server.mjs'), chatExecutable)
  fs.chmodSync(chatExecutable, 0o755)
  const chatModel = Buffer.alloc(2_048)
  chatModel.write('GGUF')
  fs.writeFileSync(path.join(profileDir, 'models', 'app093-chat.gguf'), chatModel)
  fs.writeFileSync(
    path.join(profileDir, 'models', 'active-model.json'),
    JSON.stringify({
      id: 'app093-chat',
      primary: 'app093-chat.gguf',
      mmproj: null
    })
  )

  // Installed-model/profile selection is the journey precondition. The model contains the
  // namespaces used by production to recognise a complete SDXL checkpoint.
  fs.writeFileSync(
    path.join(profileDir, 'models', IMAGE_MODEL),
    Buffer.from('GGUF first_stage_model conditioner text_encoder vae.'.repeat(80))
  )
  fs.writeFileSync(
    path.join(profileDir, 'models', 'active-modalities.json'),
    JSON.stringify({ image: IMAGE_MODEL })
  )
  await launch()
})

// Playwright requires a destructured first parameter.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  await closeApp()
  if (fs.existsSync(runtimeLog))
    fs.copyFileSync(runtimeLog, testInfo.outputPath('image-runtime.jsonl'))
  const appLog = path.join(profileDir, 'logs', 'off-grid-ai-desktop.log')
  if (fs.existsSync(appLog)) fs.copyFileSync(appLog, testInfo.outputPath('desktop.log'))
  fs.rmSync(profileDir, { recursive: true, force: true })
})

test('APP-093 generates one owned image and keeps it usable across a full relaunch', async () => {
  await enterChat(true)

  await page.getByRole('button', { name: /^Image$/ }).click()
  await expect(page.getByRole('heading', { name: 'Create an image' })).toBeVisible()
  await page.getByRole('button', { name: /Image options/i }).click()
  const imageOptions = page
  await imageOptions
    .getByRole('radiogroup', { name: 'Size', exact: true })
    .getByRole('radio', { name: '256', exact: true })
    .click()
  await imageOptions.getByRole('slider', { name: 'Steps', exact: true }).press('Home')
  await expect(imageOptions.getByRole('slider', { name: 'Steps', exact: true })).toHaveAttribute(
    'aria-valuenow',
    '4'
  )
  await imageOptions.getByLabel('Seed').fill('93')
  const enhance = imageOptions.getByLabel('Enhance')
  if (await enhance.isChecked()) await enhance.uncheck()

  const composer = page.getByPlaceholder('Describe an image to generate…')
  await composer.fill(PROMPT)
  await page.getByTitle('Send').click()

  const generated = page.getByRole('img', { name: 'Generated', exact: true })
  await expect(generated).toHaveCount(1, { timeout: 15_000 })
  // The native process can finish between renderer frames. Check its actual progress
  // emissions and the durable UI result instead of requiring each brief label to paint.
  const progressEvents = fs
    .readFileSync(runtimeLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { event: string })
    .filter(({ event }) => event.startsWith('progress:'))
    .map(({ event }) => event)
  expect(progressEvents).toEqual(['progress:1', 'progress:2', 'progress:3', 'progress:4'])
  // The image is a surface like every card: a click beside it sends the wave around its edge.
  const imageSurface = page.getByRole('button', { name: 'Open Generated', exact: true })
  const box = (await imageSurface.boundingBox())!
  // Its edge is the picture's edge: no line gap or margin inside the surface.
  const picture = (await generated.boundingBox())!
  expect(Math.round(box.height)).toBe(Math.round(picture.height))
  expect(Math.round(box.width)).toBe(Math.round(picture.width))
  await page.mouse.click(box.x + box.width + 24, box.y + box.height / 2)
  await expect(imageSurface).toHaveAttribute('data-og-wave', /.*/, { timeout: 5_000 })
  await expect(
    page.locator('p').getByText(`Generated for: ${PROMPT}`, { exact: true }).last()
  ).toBeVisible()
  await page.screenshot({
    path: path.join(evidenceDir, 'app093-generated-light.png'),
    fullPage: true
  })

  await generated.click()
  const preview = page.getByRole('dialog', { name: 'Generated image preview' })
  await expect(preview).toBeVisible()
  expect(
    await preview
      .getByRole('img', { name: 'Generated preview' })
      .evaluate((image: HTMLImageElement) => ({
        width: image.naturalWidth,
        height: image.naturalHeight
      }))
  ).toEqual({ width: 96, height: 64 })
  await preview.getByRole('button', { name: 'Close' }).click()

  const beforeRestart = await scopedImages()
  expect(beforeRestart.conversationId).toBeTruthy()
  expect(beforeRestart.images).toHaveLength(1)
  expect(beforeRestart.images[0]?.conversationId).toBe(beforeRestart.conversationId)
  expect(fs.readFileSync(beforeRestart.images[0]!.path).subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  )
  const invocations = fs
    .readFileSync(runtimeLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { event: string; pid: number })
  expect(invocations.filter((event) => event.event === 'start')).toHaveLength(1)
  expect(invocations.filter((event) => event.event === 'complete')).toHaveLength(1)

  await closeApp()
  await launch()
  await enterChat()
  const conversationEntry = page.getByText(/emerald lighthouse/i).first()
  await expect(conversationEntry).toBeVisible()
  await conversationEntry.click()
  await expect(page.getByText(PROMPT, { exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: 'Generated', exact: true })).toHaveCount(1)

  await page.getByTitle('Generated images').click()
  const gallery = page.getByText('Gallery', { exact: true }).locator('..').locator('..')
  await expect(gallery.getByRole('button', { name: 'images (1)' })).toBeVisible()
  const galleryImage = gallery.locator('img')
  await expect(galleryImage).toHaveCount(1)
  await galleryImage.click()
  await expect(page.getByRole('dialog', { name: 'Generated image preview' })).toBeVisible()
  const theme = page.getByRole('button', { name: /Theme:/ })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await page.evaluate(() => document.documentElement.dataset.theme === 'dark')) break
    await theme.click()
  }
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
  await page.screenshot({
    path: path.join(evidenceDir, 'app093-relaunch-gallery-dark.png'),
    fullPage: true
  })

  const afterRestart = await scopedImages()
  expect(afterRestart.conversationId).toBe(beforeRestart.conversationId)
  expect(afterRestart.images).toEqual(beforeRestart.images)
  expect(fs.existsSync(afterRestart.images[0]!.path)).toBe(true)
})

test('Send Now cancels the active image and saves urgent and queued images in order', async () => {
  await enterChat(true)
  await page.getByRole('button', { name: /^Image$/ }).click()
  await page.getByRole('button', { name: /Image options/i }).click()
  const imageOptions = page
  await imageOptions
    .getByRole('radiogroup', { name: 'Size', exact: true })
    .getByRole('radio', { name: '256', exact: true })
    .click()
  await imageOptions.getByRole('slider', { name: 'Steps', exact: true }).press('Home')
  await expect(imageOptions.getByRole('slider', { name: 'Steps', exact: true })).toHaveAttribute(
    'aria-valuenow',
    '4'
  )
  const enhance = imageOptions.getByLabel('Enhance')
  if (await enhance.isChecked()) await enhance.uncheck()

  const held = 'Hold this image for Send Now APP093'
  const urgent = 'An urgent green lighthouse APP093'
  const queued = 'A queued blue lighthouse APP093'
  const events = (): Array<{ event: string; prompt: string; pid: number }> =>
    fs.existsSync(runtimeLog)
      ? fs
          .readFileSync(runtimeLog, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
  const composer = page.getByPlaceholder('Describe an image to generate…')
  await composer.fill(held)
  await composer.press('Enter')
  await expect
    .poll(() =>
      events()
        .filter((entry) => entry.event === 'start')
        .map((entry) => entry.prompt)
    )
    .toEqual([held])
  await composer.fill(queued)
  await composer.press('Enter')
  await expect(
    page.getByTestId('chat-composer').getByText('1 queued', { exact: true })
  ).toBeVisible()
  await composer.fill(urgent)
  await composer.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
  await expect
    .poll(() =>
      events()
        .filter((entry) => entry.event === 'complete')
        .map((entry) => entry.prompt)
    )
    .toEqual([urgent, queued])
  expect(
    events()
      .filter((entry) => entry.event === 'start')
      .map((entry) => entry.prompt)
  ).toEqual([held, urgent, queued])
  const heldPid = events().find((entry) => entry.event === 'start' && entry.prompt === held)!.pid
  // The native image owner stops sd-cli with SIGKILL, which the child cannot log.
  expect(() => process.kill(heldPid, 0)).toThrow()
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toBeHidden()
  await expect(page.getByRole('img', { name: 'Generated', exact: true })).toHaveCount(2)
  await expect(
    page.getByTestId('chat-composer').getByText('1 queued', { exact: true })
  ).toBeHidden()

  const before = await scopedImages()
  expect(before.images).toHaveLength(2)
  const stored = await page.evaluate(
    async (conversationId) =>
      (await window.api.getRagMessages(conversationId)).map((message) => ({
        role: message.role,
        content: message.content
      })),
    before.conversationId
  )
  expect(
    stored.filter((message) => message.role === 'user').map((message) => message.content)
  ).toEqual([held, urgent, queued])
  const replies = stored.filter((message) => message.role === 'assistant')
  expect(replies).toHaveLength(2)
  expect(replies[0]?.content).toContain(urgent)
  expect(replies[1]?.content).toContain(queued)

  await closeApp()
  await launch()
  await enterChat()
  await expect(page.getByRole('img', { name: 'Generated', exact: true })).toHaveCount(2)
  const after = await scopedImages()
  expect(after).toEqual(before)
  expect(after.images.every((image) => fs.existsSync(image.path))).toBe(true)
})

for (const action of ['finish', 'send-now', 'stop']) {
  const sendNow = action === 'send-now'
  const stop = action === 'stop'
  test(`reattached image chat drains queued images${sendNow ? ' with Send Now first' : stop ? ' with ordinary Stop clearing queued drafts' : ' after natural completion'}`, async () => {
    await enterChat(true)
    await page.getByRole('button', { name: /^Image$/ }).click()
    await page.getByRole('button', { name: /Image options/i }).click()
    const options = page
    await options
      .getByRole('radiogroup', { name: 'Size', exact: true })
      .getByRole('radio', { name: '256', exact: true })
      .click()
    await options.getByRole('slider', { name: 'Steps', exact: true }).press('Home')
    await expect(options.getByRole('slider', { name: 'Steps', exact: true })).toHaveAttribute(
      'aria-valuenow',
      '4'
    )
    if (await options.getByLabel('Enhance').isChecked())
      await options.getByLabel('Enhance').uncheck()
    const held =
      sendNow || stop
        ? 'Hold this image for Send Now APP093'
        : 'Finish this image after reopen APP093'
    const queued = 'A queued blue lighthouse APP093'
    const urgent = 'An urgent green lighthouse APP093'
    const events = (): Array<{ event: string; prompt: string }> =>
      fs.existsSync(runtimeLog)
        ? fs
            .readFileSync(runtimeLog, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : []
    let composer = page.locator('textarea')
    await composer.fill(held)
    await composer.press('Enter')
    await expect
      .poll(() =>
        events()
          .filter((entry) => entry.event === 'start')
          .map((entry) => entry.prompt)
      )
      .toEqual([held])
    await composer.fill(queued)
    await composer.press('Enter')
    await expect(
      page.getByTestId('chat-composer').getByText('1 queued', { exact: true })
    ).toBeVisible()
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
    await enterChat()
    await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toBeVisible()
    await expect(
      page.getByTestId('chat-composer').getByText('1 queued', { exact: true })
    ).toBeVisible()
    await page.getByRole('button', { name: /^Image$/ }).click()
    await page.getByRole('button', { name: /Image options/i }).click()
    const reopenedOptions = page
    await reopenedOptions
      .getByRole('radiogroup', { name: 'Size', exact: true })
      .getByRole('radio', { name: '256', exact: true })
      .click()
    await reopenedOptions.getByRole('slider', { name: 'Steps', exact: true }).press('Home')
    await expect(
      reopenedOptions.getByRole('slider', { name: 'Steps', exact: true })
    ).toHaveAttribute('aria-valuenow', '4')
    if (await reopenedOptions.getByLabel('Enhance').isChecked())
      await reopenedOptions.getByLabel('Enhance').uncheck()
    if (stop) {
      await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toBeHidden()
    }
    if (sendNow || stop) {
      composer = page.locator('textarea')
      await composer.fill(urgent)
      await composer.press(
        stop ? 'Enter' : process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter'
      )
    }
    const completed = stop ? [urgent] : sendNow ? [urgent, queued] : [held, queued]
    await expect
      .poll(() =>
        events()
          .filter((entry) => entry.event === 'complete')
          .map((entry) => entry.prompt)
      )
      .toEqual(completed)
    await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toBeHidden()
    await expect(page.getByRole('img', { name: 'Generated', exact: true })).toHaveCount(
      completed.length
    )
    const owned = await scopedImages()
    const stored = await page.evaluate(
      async (id) => window.api.getRagMessages(id),
      owned.conversationId
    )
    expect(
      stored.filter((message) => message.role === 'assistant').map((message) => message.content)
    ).toEqual(completed.map((prompt) => `Generated for: ${prompt}`))
    await closeApp()
    await launch()
    await enterChat()
    await expect(page.getByRole('img', { name: 'Generated', exact: true })).toHaveCount(
      completed.length
    )
    expect(await scopedImages()).toEqual(owned)
  })
}
