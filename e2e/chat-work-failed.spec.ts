import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid } from './helpers/launch'

// The real built app over a faithful model boundary (fixtures/work-failed-llama-server.mjs). The model
// asks the real read_url tool for a page on a port nothing listens on, so that step fails, then it
// answers. The turn's work summary must say the work failed, not that it was done.

let app: ElectronApplication | null = null
let page: Page
let profileDir = ''

test.describe.configure({ timeout: 180_000 })

test.beforeAll(async () => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-work-failed-'))
  const models = path.join(profileDir, 'models')
  const llama = path.join(profileDir, 'bin', 'llama')
  fs.mkdirSync(models, { recursive: true })
  fs.mkdirSync(llama, { recursive: true })
  const bytes = Buffer.alloc(2_048)
  bytes.write('GGUF')
  fs.writeFileSync(path.join(models, 'fake-chat.gguf'), bytes)
  fs.writeFileSync(
    path.join(models, 'active-model.json'),
    JSON.stringify({ id: 'e2e-chat', primary: 'fake-chat.gguf' })
  )
  const server = path.join(llama, 'llama-server')
  fs.copyFileSync(
    path.join(process.cwd(), 'e2e', 'fixtures', 'work-failed-llama-server.mjs'),
    server
  )
  fs.chmodSync(server, 0o755)

  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_BIN_DIR: path.join(profileDir, 'bin'),
      OFFGRID_PRO: '1',
      OFFGRID_E2E_HEADLESS: '1',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => console.error(`[renderer error] ${error.stack ?? error.message}`))
  await page.waitForLoadState('domcontentloaded')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await completeOnboarding(page)
  await page.evaluate(() => window.api.saveSetting('composerToolsOn', true))
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  fs.rmSync(profileDir, { recursive: true, force: true })
})

test('a turn whose last step failed is summarised as failed work', async () => {
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true })
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click()

  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await composer.fill('Read http://127.0.0.1:9/ and tell me what it says')
  await page.keyboard.press('Enter')

  // The transcript bubble (the chat rail also previews the last message, so take the last match).
  await expect(page.getByText('I could not open that page.', { exact: true }).last()).toBeVisible({
    timeout: 60_000
  })
  const summary = page.getByRole('button', { name: 'Work failed', exact: true })
  await expect(summary).toBeVisible()
  await expect(page.getByRole('button', { name: 'Work done', exact: true })).toHaveCount(0)

  await summary.click()
  await expect(page.getByRole('button', { name: /, failed$/ }).first()).toBeVisible()
  await page.screenshot({ path: 'e2e/screenshots/chat-work-failed.png' })
})
