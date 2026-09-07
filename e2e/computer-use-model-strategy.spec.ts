import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { gotoSettings, openSettingsSection } from './helpers/settings'

let app: ElectronApplication | null = null
let page: Page
let profileDir: string

const CHAT_ID = 'unsloth/Qwen3.5-0.8B-GGUF'
const CHAT_NAME = 'Qwen 3.5 0.8B'
const SPECIALIST_ID = 'mradermacher/UI-TARS-1.5-7B-GGUF'

// This journey starts the native model boundary, reopens Electron, and runs a complete visual
// task. The default 60-second budget can expire during model startup before a product assertion.
test.describe.configure({ timeout: 180_000 })

function executable(source: string, target: string): void {
  fs.copyFileSync(source, target)
  fs.chmodSync(target, 0o755)
}

async function stageWorld(): Promise<void> {
  const models = path.join(profileDir, 'models')
  const bin = path.join(profileDir, 'bin')
  const llama = path.join(bin, 'llama')
  fs.mkdirSync(models, { recursive: true })
  fs.mkdirSync(llama, { recursive: true })
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
  executable(
    path.join(process.cwd(), 'e2e/fixtures/computer-use-hybrid-llama-server.mjs'),
    path.join(llama, 'llama-server')
  )
  executable(
    path.join(process.cwd(), 'e2e/fixtures/computer-use-capture.mjs'),
    path.join(bin, 'computer-use-capture')
  )
  await sharp({
    create: { width: 640, height: 400, channels: 4, background: '#f5f5f5' }
  })
    .png()
    .toFile(path.join(profileDir, 'computer-use-frame.png'))

  const nut = path.join(profileDir, 'node_modules/@nut-tree-fork/nut-js')
  fs.mkdirSync(nut, { recursive: true })
  fs.writeFileSync(
    path.join(nut, 'index.js'),
    `class Point { constructor(x, y) { this.x = x; this.y = y } }
const done = async () => undefined
module.exports = {
  Point,
  Button: { LEFT: 1, RIGHT: 2, MIDDLE: 3 },
  Key: {},
  mouse: { setPosition: done, leftClick: done, rightClick: done, click: done, doubleClick: done, drag: done, scrollUp: done, scrollDown: done, scrollLeft: done, scrollRight: done },
  keyboard: { type: done, pressKey: done, releaseKey: done }
}`
  )
}

async function launch(): Promise<void> {
  app = await launchOffGrid({
    cwd: profileDir,
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_BIN_DIR: path.join(profileDir, 'bin'),
      OFFGRID_PRO: '1',
      OFFGRID_E2E_HEADLESS: '1',
      OFFGRID_E2E_PRO_TASKS: '1',
      OFFGRID_E2E_COMPUTER_USE_BOUNDARY: '1',
      OFFGRID_E2E_COMPUTER_USE_FRAME: path.join(profileDir, 'computer-use-frame.png'),
      NODE_PATH: path.join(profileDir, 'node_modules'),
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => console.error(`[renderer error] ${error.stack ?? error.message}`))
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
  await expect(page.getByRole('button', { name: /Model server: model running/i })).toBeVisible({
    timeout: 60_000
  })
}

async function close(): Promise<void> {
  const running = app
  app = null
  if (running) await running.close()
}

async function selectStrategy(label: string): Promise<void> {
  await gotoSettings(page)
  await openSettingsSection(page, 'Computer use')
  const strategy = page.getByRole('button', { name: 'Computer Use model strategy' })
  await strategy.click()
  await page.getByRole('menuitemradio', { name: label, exact: true }).click()
  await expect(strategy).toContainText(label)
}

async function gotoChat(): Promise<void> {
  await page.keyboard.press('Meta+K')
  const palette = page.getByRole('dialog', { name: 'Search Off Grid AI' })
  await expect(palette).toBeVisible()
  await palette.getByPlaceholder(/^Search everything/).fill('Chat')
  await page.getByTestId('palette-screen-memory-chat-root').click()
  await expect(page.getByPlaceholder(/ask anything/i)).toBeVisible()
}

async function computerUseSummary(): Promise<string> {
  await gotoChat()
  await page.getByRole('button', { name: 'Active models' }).click()
  const region = page.getByRole('region', { name: 'Computer Use' })
  await expect(region).toBeVisible()
  await expect(region).not.toContainText('No Computer Use model is selected.', { timeout: 30_000 })
  const text = await region.innerText()
  await page.getByRole('button', { name: 'Close' }).click()
  return text
}

test.beforeEach(async () => {
  test.skip(targetIsPackaged(), 'dev-target journey uses scripted native boundaries')
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-computer-use-strategy-'))
  await stageWorld()
  await launch()
})

test.afterEach(async () => {
  await close()
  fs.rmSync(profileDir, { recursive: true, force: true })
})

test('all strategies project their effective roles and Text + Specialist survives relaunch', async () => {
  await selectStrategy('Same as Chat')
  expect(await computerUseSummary()).toContain('Same as Chat')
  expect(await computerUseSummary()).toContain(CHAT_NAME)

  await selectStrategy('Specialist')
  const specialist = await computerUseSummary()
  expect(specialist).toContain('Specialist')
  expect(specialist.toLowerCase()).toContain('grounding specialist')
  expect(specialist.toLowerCase()).not.toContain('reasoner')

  await selectStrategy('Text + Specialist')
  const hybrid = await computerUseSummary()
  expect(hybrid.toLowerCase()).toContain('reasoner')
  expect(hybrid.toLowerCase()).toContain('grounding specialist')

  await close()
  await launch()
  expect(await computerUseSummary()).toContain('Text + Specialist')
})

test('a Chat request runs the hybrid reasoner and specialist through one Computer Use task', async () => {
  await selectStrategy('Text + Specialist')
  await gotoChat()
  const composer = page.getByPlaceholder(/ask anything/i)
  await page.getByRole('button', { name: 'Composer options' }).click()
  await page.getByRole('menuitem', { name: /^Tools/ }).click()
  await page.keyboard.press('Escape')
  await composer.fill('Click the center of this test window.')
  await composer.press('Enter')

  await expect(
    page.getByRole('button', {
      name: /Computer Use done Click the center of the visible Off Grid AI test window/
    })
  ).toBeVisible({ timeout: 120_000 })
  expect(
    fs.existsSync(path.join(profileDir, 'hybrid-model-state.json')),
    'the scripted native model boundary must record hybrid reasoning'
  ).toBe(true)
  const state = JSON.parse(
    fs.readFileSync(path.join(profileDir, 'hybrid-model-state.json'), 'utf8')
  ) as { reasonerCalls: number }
  expect(state.reasonerCalls).toBeGreaterThanOrEqual(2)
  const requests = fs
    .readFileSync(path.join(profileDir, 'hybrid-model-requests.jsonl'), 'utf8')
    .trim()
    .split('\n')
  expect(requests.some((request) => request.includes('delegate_grounded_action'))).toBe(true)
  expect(requests.some((request) => request.includes('"max_tokens":200'))).toBe(true)
})

for (const [strategy, counter] of [
  ['Same as Chat', 'sameAsChatCalls'],
  ['Specialist', 'specialistCalls']
] as const) {
  test(`a Chat request completes a real Computer Use task with ${strategy}`, async () => {
    await selectStrategy(strategy)
    await gotoChat()
    const composer = page.getByPlaceholder(/ask anything/i)
    await page.getByRole('button', { name: 'Composer options' }).click()
    await page.getByRole('menuitem', { name: /^Tools/ }).click()
    await page.keyboard.press('Escape')
    await composer.fill('Click the center of this test window.')
    await composer.press('Enter')

    await expect(
      page.getByRole('button', {
        name: /Computer Use done Click the center of the visible Off Grid AI test window/
      })
    ).toBeVisible({ timeout: 120_000 })
    const state = JSON.parse(
      fs.readFileSync(path.join(profileDir, 'hybrid-model-state.json'), 'utf8')
    ) as Record<string, number>
    expect(state[counter]).toBeGreaterThanOrEqual(2)
  })
}
