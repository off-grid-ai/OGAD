import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid } from './helpers/launch'

// The real built app, on its own profile: an image model with two quantizations is ONE card whose
// side panel picks the quantization, and Active models shows every slot the same way, the active
// model as a card with Unload and a dropdown for the rest, Task roles included.

let app: ElectronApplication | null = null
let page: Page
let profileDir: string

const CHAT_ID = 'unsloth/Qwen3.5-0.8B-GGUF'
const SPECIALIST_ID = 'mradermacher/UI-TARS-1.5-7B-GGUF'

test.describe.configure({ timeout: 180_000 })

function stageModels(): void {
  const models = path.join(profileDir, 'models')
  fs.mkdirSync(models, { recursive: true })
  for (const file of [
    'Qwen3.5-0.8B-Q4_K_M.gguf',
    'mmproj-Qwen3.5-0.8B-BF16.gguf',
    'UI-TARS-1.5-7B.Q4_K_M.gguf',
    'UI-TARS-1.5-7B.mmproj-f16.gguf'
  ]) {
    const bytes = Buffer.alloc(2_048)
    bytes.write('GGUF')
    fs.writeFileSync(path.join(models, file), bytes)
  }
  fs.writeFileSync(
    path.join(models, 'active-model.json'),
    JSON.stringify({
      id: CHAT_ID,
      primary: 'Qwen3.5-0.8B-Q4_K_M.gguf',
      mmproj: 'mmproj-Qwen3.5-0.8B-BF16.gguf'
    })
  )
  fs.writeFileSync(
    path.join(models, 'active-modalities.json'),
    JSON.stringify({ computer_use: SPECIALIST_ID })
  )
}

test.beforeEach(async () => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-one-card-'))
  stageModels()
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_PRO: '1',
      OFFGRID_E2E_HEADLESS: '1',
      OFFGRID_E2E_PRO_TASKS: '1',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => console.error(`[renderer error] ${error.stack ?? error.message}`))
  await page.waitForLoadState('domcontentloaded')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await completeOnboarding(page)
})

test.afterEach(async () => {
  const running = app
  app = null
  await running?.close()
  fs.rmSync(profileDir, { recursive: true, force: true })
})

test('an image model with two quantizations is one card, sized in its side panel', async () => {
  await page.getByRole('button', { name: 'Models', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible()
  await page.getByRole('radio', { name: 'Image', exact: true }).click()

  await expect(page.getByText('RealVisXL v5.0 (photoreal)', { exact: true })).toHaveCount(1)
  await expect(page.getByText(/\(Light\)$/)).toHaveCount(0)
  await page.screenshot({ path: 'e2e/screenshots/models-image-one-card.png' })

  await page.getByText('RealVisXL v5.0 (photoreal)', { exact: true }).click()
  const panel = page.getByRole('dialog', { name: /RealVisXL v5\.0/ })
  const choice = panel.getByRole('radiogroup', { name: 'Quantization' })
  await expect(choice.getByRole('radio', { name: /Full quality/ })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await choice.getByRole('radio', { name: /Light/ }).click()
  await expect(choice.getByRole('radio', { name: /Light/ })).toHaveAttribute('aria-checked', 'true')
  await page.screenshot({ path: 'e2e/screenshots/models-image-quantization-panel.png' })
})

test('Active models shows every slot as an active card with Unload, Task roles included', async () => {
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await page.getByRole('button', { name: 'Active models' }).click()
  await expect(page.getByLabel('Text & Vision active model')).toContainText(/Qwen.*3\.5.*0\.8B/)

  const grounding = page.getByRole('region', { name: 'Computer Use Grounding specialist' })
  await expect(grounding).toBeVisible()
  await expect(page.getByLabel('Computer Use Grounding specialist active model')).toContainText(
    'UI-TARS'
  )
  await expect(grounding.getByRole('button', { name: 'Unload' })).toBeVisible()
  await page.screenshot({ path: 'e2e/screenshots/active-models-slots.png' })
})
