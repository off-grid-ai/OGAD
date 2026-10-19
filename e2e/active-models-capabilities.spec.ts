import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid } from './helpers/launch'
import { ggufFile, PLAIN_TEMPLATE, TOOL_AND_THINKING_TEMPLATE } from './helpers/gguf'

// The real built app, on its own profile. What Active models says a model can do comes from the
// staged files themselves: a projector means it sees images, and the GGUF chat template says whether
// it calls tools and reasons. Task roles that point at a model this device never downloaded, or at a
// remote server that is gone, read as what they are.

let app: ElectronApplication | null = null
let page: Page
let profileDir: string

const TOOLS_CHAT = 'unsloth/Qwen3.5-0.8B-GGUF'
const SPECIALIST_ID = 'mradermacher/UI-TARS-1.5-7B-GGUF'
const GONE_REMOTE_DECIDER = 'remote-vision:ghost-server:jaredpalmer%2Fkev-4b'

test.describe.configure({ timeout: 180_000 })

function stageModels(): void {
  const models = path.join(profileDir, 'models')
  fs.mkdirSync(path.join(models, 'decision-eval'), { recursive: true })
  const write = (name: string, bytes: Buffer): void =>
    fs.writeFileSync(path.join(models, name), bytes)
  // The chosen chat model: a vision projector, and a template that wires tools and thinking.
  write('Qwen3.5-0.8B-Q4_K_M.gguf', ggufFile(TOOL_AND_THINKING_TEMPLATE))
  write('mmproj-Qwen3.5-0.8B-BF16.gguf', ggufFile())
  // The other chat model on the device: it sees images, but its template wires nothing else.
  write('Qwen3.5-2B-Q4_K_M.gguf', ggufFile(PLAIN_TEMPLATE))
  write('mmproj-Qwen3.5-2B-BF16.gguf', ggufFile())
  // A decision model staged for evaluation: a chat-shaped file that is not a chat model.
  write(
    path.join('decision-eval', 'decider-2b-eval-q8_0.gguf'),
    ggufFile(TOOL_AND_THINKING_TEMPLATE)
  )
  fs.writeFileSync(
    path.join(models, 'active-model.json'),
    JSON.stringify({
      id: TOOLS_CHAT,
      primary: 'Qwen3.5-0.8B-Q4_K_M.gguf',
      mmproj: 'mmproj-Qwen3.5-0.8B-BF16.gguf'
    })
  )
}

test.beforeEach(async () => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-capabilities-'))
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
  // Computer Use runs a decision model with a grounding specialist. The decision model is on a remote
  // server this device no longer has; the specialist is a catalog model it never downloaded.
  await page.evaluate(
    ([decisionModelId, groundingModelId]) =>
      window.api.saveSetting('computerUseSettings', {
        modelStrategy: 'decision_plus_specialist',
        context: 'auto',
        screenshotSize: 'balanced',
        screenshotQuality: 'balanced',
        checkpointInterval: 9,
        visualHistoryFrames: 2,
        retrieveOlderVisuals: false,
        decisionModelId,
        groundingModelId
      }),
    [GONE_REMOTE_DECIDER, SPECIALIST_ID]
  )
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await page.getByRole('button', { name: 'Active models' }).click()
})

test.afterEach(async () => {
  const running = app
  app = null
  await running?.close()
  fs.rmSync(profileDir, { recursive: true, force: true })
})

test("the chosen chat model's card names what its files say it can do", async () => {
  const card = page.getByLabel('Text & Vision active model')
  await expect(card).toContainText(/Qwen.*3\.5.*0\.8B/)
  await expect(card.getByRole('img', { name: 'Sees images' })).toBeVisible()
  await expect(card.getByRole('img', { name: 'Calls tools' })).toBeVisible()
  await expect(card.getByRole('img', { name: 'Reasons step by step' })).toBeVisible()
  await page.screenshot({ path: 'e2e/screenshots/active-models-capabilities-card.png' })
})

test('the dropdown offers the other chat model with its own capabilities, flush under the input', async () => {
  const input = page.getByRole('combobox', { name: 'Text & Vision model' })
  await input.click()
  const other = page.getByRole('option', { name: /Qwen.*3\.5.*2B/ })
  await expect(other).toBeVisible()
  await expect(other.getByRole('img', { name: 'Sees images' })).toBeVisible()
  await expect(other.getByRole('img', { name: 'Calls tools' })).toHaveCount(0)
  await expect(other.getByRole('img', { name: 'Reasons step by step' })).toHaveCount(0)
  await expect(other).toContainText('2B')
  // A decision model staged for evaluation is never offered as a chat model.
  await expect(page.getByRole('option', { name: /decider/i })).toHaveCount(0)

  // No empty check-mark column before the label. That column put labels about 24px right of the
  // input text; without it the label sits within the list's own few pixels of padding.
  const [inputTextLeft, labelLeft] = await Promise.all([
    input.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return box.left + parseFloat(getComputedStyle(element).paddingLeft)
    }),
    other
      .locator('span.truncate')
      .first()
      .evaluate((element) => element.getBoundingClientRect().left)
  ])
  expect(Math.abs(labelLeft - inputTextLeft)).toBeLessThan(8)
  await page.screenshot({ path: 'e2e/screenshots/active-models-capabilities-dropdown.png' })
})

test('a role pointing at a model this device never downloaded offers to fetch it', async () => {
  const slot = page.getByRole('region', { name: 'Computer Use Grounding specialist' })
  await expect(slot).toBeVisible()
  await expect(slot.getByRole('button', { name: /^Download UI-TARS/ })).toBeVisible()
  await expect(slot).toContainText('Not downloaded')
  await expect(slot).not.toContainText('On device')
})

test('a decision model whose remote server is gone reads as remote, not as a missing download', async () => {
  const slot = page.getByRole('region', { name: 'Computer Use Decision model' })
  await expect(slot).toBeVisible()
  await expect(slot.getByRole('img', { name: 'Remote' })).toBeVisible()
  await expect(slot).not.toContainText('Not downloaded')
  await expect(slot.getByRole('button', { name: /^Download/ })).toHaveCount(0)
  await page.screenshot({ path: 'e2e/screenshots/active-models-remote-decider.png' })
})
