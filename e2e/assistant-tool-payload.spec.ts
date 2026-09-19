import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'

let app: ElectronApplication | null = null
let page: Page
let profileDir: string

test.beforeEach(async () => {
  test.skip(targetIsPackaged(), 'This test uses a local model boundary in the dev build')
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-assistant-tools-'))
  const modelsDir = path.join(profileDir, 'models')
  const llamaDir = path.join(profileDir, 'bin', 'llama')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })
  const model = Buffer.alloc(2_048)
  model.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'assistant-tools.gguf'), model)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'assistant-tools-model', primary: 'assistant-tools.gguf', mmproj: null })
  )
  const executable = path.join(llamaDir, 'llama-server')
  fs.copyFileSync(
    path.join(process.cwd(), 'e2e/fixtures/app045-streaming-llama-server.mjs'),
    executable
  )
  fs.chmodSync(executable, 0o755)

  app = await launchOffGrid({
    cwd: profileDir,
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_BIN_DIR: path.join(profileDir, 'bin'),
      OFFGRID_PRO: '1',
      OFFGRID_E2E_HEADLESS: '1',
      OFFGRID_E2E_PRO_TASKS: '1',
      OFFGRID_E2E_ISOLATED_INSTANCE: '1',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
})

test.afterEach(async () => {
  await app?.close()
  fs.rmSync(profileDir, { recursive: true, force: true })
})

test('Assistant sends only tools pertinent to the message', async () => {
  await page.keyboard.press('Meta+K')
  const palette = page.getByRole('dialog', { name: 'Search Off Grid AI' })
  await expect(palette).toBeVisible()
  await palette.getByPlaceholder(/^Search everything/).fill('Chat')
  await page.getByTestId('palette-screen-memory-chat-root').click()
  const composer = page.getByPlaceholder(/ask anything/i)
  await expect(composer).toBeVisible()
  const captureDismiss = page.getByRole('button', { name: 'Dismiss', exact: true })
  if (await captureDismiss.isVisible().catch(() => false)) await captureDismiss.click()

  const assistant = page
    .getByTestId('chat-composer')
    .getByRole('button', { name: 'Assistant', exact: true })
  await assistant.click()
  await expect(assistant).toHaveAttribute('aria-pressed', 'true')
  await composer.fill('What meetings do I have tomorrow?')
  await composer.press('Enter')

  const toolsSent = page.getByRole('button', { name: /^Tools sent in request \(/ }).last()
  await expect(toolsSent).toBeVisible({ timeout: 30_000 })
  await toolsSent.click()
  await expect(page.getByText('search_meetings', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('get_datetime', { exact: true })).toHaveCount(0)
  await expect(page.getByText('computer_use', { exact: true })).toHaveCount(0)
})
