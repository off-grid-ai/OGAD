import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { pairedBrowser, type FakeExtension } from './helpers/fake-extension'
import { closeAndWait, mainWindow } from './helpers/windows'

// The real app runs a Web Use task in the paired browser, and the model stops answering while it
// decides the task's next step, so the task fails mid-decision. Opening that task must show it as
// failed, not as still "Deciding the next step": the last action is history once the task is over.
// Boundaries: the paired browser (fake extension) and a llama-server fixture executable.

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))
const HEADLINE = 'Harbour News'
const ASK = 'Read the headline of the page in my browser; this page cannot finish.'

let app: ElectronApplication | null = null
let page: Page
let profileDir = ''
let browser: FakeExtension | null = null

test.describe.configure({ timeout: 180_000 })

/** A port free right now, for this app's gateway. */
const freePort = async (): Promise<number> => {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as net.AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

test.beforeAll(async () => {
  test.skip(targetIsPackaged(), 'This native-model boundary is for the source-built E2E target.')
  test.skip(!PRO_PRESENT, 'pro package not present: Web Use is a Pro surface')
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-web-use-failed-'))
  const modelsDir = path.join(profileDir, 'models')
  const llamaDir = path.join(profileDir, 'bin', 'llama')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })
  const gguf = Buffer.alloc(2_048)
  gguf.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'web-task.gguf'), gguf)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'paired-web-task-model', primary: 'web-task.gguf', mmproj: null })
  )
  const executable = path.join(llamaDir, 'llama-server')
  fs.copyFileSync(path.resolve('e2e/fixtures/paired-web-task-llama-server.mjs'), executable)
  fs.chmodSync(executable, 0o755)
  const gatewayPort = await freePort()
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_BIN_DIR: path.join(profileDir, 'bin'),
      OFFGRID_PRO: '1',
      OFFGRID_GATEWAY_PORT: String(gatewayPort),
      NODE_ENV: 'production',
      NO_PROXY: '127.0.0.1,localhost'
    }
  })
  page = await mainWindow(app)
  page.on('pageerror', (error) => console.error(`[renderer error] ${error.stack ?? error.message}`))
  await completeOnboarding(page)
  browser = await pairedBrowser(app, 'E2E Browser', gatewayPort)
  browser.answers.set('page.call', (command) => ({
    text:
      command.args.tool === 'browser_snapshot'
        ? `- Page URL: https://example.test/\n- Page Title: ${HEADLINE}\n- Page Snapshot:\n\`\`\`yaml\n- heading "${HEADLINE}" [level=1] [ref=e2]\n\`\`\``
        : 'Done.',
    isError: false
  }))
})

test.afterAll(async () => {
  await browser?.close()
  if (app) await closeAndWait(app)
  if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
})

test('a Web Use task that failed mid-decision reads as failed, not as still deciding', async () => {
  // Settings → Tasks → Web Use browser: the default browser (the paired one).
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await page.getByRole('button', { name: 'Active models', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).last().click()
  await page.getByRole('radio', { name: 'tasks', exact: true }).click()
  await page.getByRole('combobox', { name: 'Web Use browser' }).click()
  await page.getByRole('option', { name: 'Default browser', exact: true }).click()
  await expect(page.getByText('Connected: E2E Browser.', { exact: false })).toBeVisible({
    timeout: 15_000
  })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await composer.fill(ASK)
  await composer.press('Enter')

  const panel = page.getByRole('region', { name: 'Tasks' })
  const header = panel.getByTestId('task-live-controls')
  await expect(header).toContainText('failed', { timeout: 60_000 })
  await expect(header).not.toContainText('Deciding the next step')
  await expect(header.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  await page.screenshot({ path: 'e2e/screenshots/web-use-failed-task-status.png' })
})
