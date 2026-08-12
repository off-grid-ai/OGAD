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
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
}

const enterChat = async (newChat = false): Promise<void> => {
  const chat = page.getByRole('button', { name: /^Chat$/i }).first()
  await expect(chat).toBeVisible()
  await chat.click()
  await expect(page.locator('textarea')).toBeVisible()
  const dismissSetup = page.getByRole('button', { name: 'Dismiss', exact: true })
  if (await dismissSetup.isVisible().catch(() => false)) await dismissSetup.click()
  if (newChat) {
    await page.getByRole('button', { name: 'New chat', exact: true }).click()
    await expect(page.getByPlaceholder('Ask anything…')).toBeVisible()
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
  fs.mkdirSync(path.join(profileDir, 'models'), { recursive: true })
  fs.mkdirSync(evidenceDir, { recursive: true })

  const boundarySource = path.resolve('e2e/fixtures/app093-image-runtime-boundary.mjs')
  const boundaryExecutable = path.join(boundaryBinDir, 'sd', 'sd-cli')
  fs.copyFileSync(boundarySource, boundaryExecutable)
  fs.chmodSync(boundaryExecutable, 0o755)

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

test.afterEach(async () => {
  await closeApp()
  fs.rmSync(profileDir, { recursive: true, force: true })
})

test('APP-093 generates one owned image and keeps it usable across a full relaunch', async () => {
  await enterChat(true)

  await page.getByRole('button', { name: /^Image$/ }).click()
  await expect(page.getByRole('heading', { name: 'Create an image' })).toBeVisible()
  await page.getByRole('button', { name: /Image options/i }).click()
  const imageOptions = page
    .locator('div')
    .filter({ has: page.getByText('Guidance', { exact: true }) })
    .last()
  await imageOptions.getByLabel('Size').selectOption('256')
  await imageOptions.getByLabel('Steps').fill('4')
  await imageOptions.getByLabel('Seed').fill('93')
  const enhance = imageOptions.getByLabel('Enhance')
  if (await enhance.isChecked()) await enhance.uncheck()

  const composer = page.getByPlaceholder('Describe an image to generate…')
  await composer.fill(PROMPT)
  await page.evaluate(() => {
    const state = window as typeof window & {
      __app093Progress?: string[]
      __app093Observer?: MutationObserver
    }
    state.__app093Progress = []
    state.__app093Observer = new MutationObserver(() => {
      const step = document.body.innerText.match(/Step \d+\/4/)?.[0]
      if (step && !state.__app093Progress?.includes(step)) state.__app093Progress?.push(step)
    })
    state.__app093Observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    })
  })
  await page.getByTitle('Send').click()

  await expect(page.getByText('Loading model…')).toBeVisible()
  const generated = page.getByRole('img', { name: 'Generated', exact: true })
  await expect(generated).toHaveCount(1, { timeout: 15_000 })
  const renderedProgress = await page.evaluate(() => {
    const state = window as typeof window & {
      __app093Progress?: string[]
      __app093Observer?: MutationObserver
    }
    state.__app093Observer?.disconnect()
    return state.__app093Progress ?? []
  })
  expect(renderedProgress).toContain('Step 1/4')
  expect(renderedProgress).toContain('Step 4/4')
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
