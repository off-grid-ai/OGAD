/**
 * A running web task keeps its header pinned while the Tasks panel scrolls.
 *
 * Same boundaries as browser-web-task.spec.ts: the real app, Web Use host and task loop; a fake
 * paired browser and a fake llama-server that holds the task while it runs. With the default
 * browser chosen, the task runs on this device outside a watched browser, so the Tasks panel is
 * one column: the task's header (title, state, Pause / Take Over / Stop) above its steps and the
 * other tasks, all in one scroller. Earlier tasks are run to the end first, through the same chat
 * and task loop, so that scroller overflows; the last one asks to go "slowly", which the model
 * holds open.
 *
 * Asserts: scrolled part way and to the end, the header stays at the top of the scroller and Stop
 * stays in view; Stop, pressed from there, ends the task.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { pairedBrowser, type FakeExtension } from './helpers/fake-extension'
import { closeAndWait, mainWindow } from './helpers/windows'

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))
const HEADLINE = 'Harbour News'
const ASK = 'Read the headline of the page in my browser.'
const ASK_SLOWLY = 'Read the headline of the page in my browser, slowly.'
const EARLIER_TASKS = 4

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let modelLog: string
let browser: FakeExtension | null = null

/** A port free right now, for this app's gateway: the spec then shares no port with the dev app or
 *  another lane's tests, which otherwise all want 7878. */
const freePort = async (): Promise<number> => {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as net.AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

const launch = async (): Promise<void> => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-sticky-header-'))
  modelLog = path.join(profileDir, 'model-requests.jsonl')
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
      OFFGRID_WEB_TASK_LOG: modelLog,
      OFFGRID_PRO: '1',
      OFFGRID_GATEWAY_PORT: String(gatewayPort),
      NODE_ENV: 'production',
      NO_PROXY: '127.0.0.1,localhost'
    }
  })
  page = await mainWindow(app)
  await completeOnboarding(page)
  browser = await pairedBrowser(app, 'E2E Browser', gatewayPort)
  browser.answers.set('page.call', (command) => ({
    text:
      command.args.tool === 'browser_snapshot'
        ? `- Page URL: https://example.test/\n- Page Title: ${HEADLINE}\n- Page Snapshot:\n\`\`\`yaml\n- heading "${HEADLINE}" [level=1] [ref=e2]\n\`\`\``
        : 'Done.',
    isError: false
  }))
}

test.describe('The running task header', () => {
  test.skip(targetIsPackaged(), 'This native-model boundary is for the source-built E2E target.')

  test.beforeEach(async () => {
    test.skip(!PRO_PRESENT, 'pro package not present: Web Use is a Pro surface')
  })

  // Playwright requires the first callback argument to use object destructuring.
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    await browser?.close()
    browser = null
    if (app) await closeAndWait(app)
    app = null
    if (modelLog && fs.existsSync(modelLog))
      fs.copyFileSync(modelLog, testInfo.outputPath('model-requests.jsonl'))
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('stays pinned with Stop in reach while the Tasks panel scrolls', async ({
    browserName: _browserName
  }, testInfo) => {
    test.setTimeout(150_000)
    await launch()
    // Settings → Tasks → Web Use browser: the default browser.
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
    // Short enough that the task and the earlier tasks overflow the panel.
    await app!.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 20, y: 40, width: 1480, height: 620 })
    })
    const composer = page.getByRole('textbox', { name: 'Message', exact: true })
    const newChat = page.getByRole('button', { name: 'New chat', exact: true })
    // Each earlier task runs in its own chat, to the end.
    for (let task = 0; task < EARLIER_TASKS; task++) {
      await newChat.click()
      await composer.fill(ASK)
      await composer.press('Enter')
      await expect(page.getByText('Web Use done', { exact: true }).first()).toBeVisible({
        timeout: 60_000
      })
    }
    const pageCalls = browser!.commands.filter((command) => command.op === 'page.call').length
    await newChat.click()
    await composer.fill(ASK_SLOWLY)
    await composer.press('Enter')
    await expect
      .poll(() => browser!.commands.filter((command) => command.op === 'page.call').length, {
        timeout: 60_000
      })
      .toBeGreaterThan(pageCalls)

    const panel = page.getByRole('region', { name: 'Tasks' })
    const header = panel.getByTestId('task-live-controls')
    const stop = header.getByRole('button', { name: 'Stop', exact: true })
    await expect(stop).toBeVisible({ timeout: 30_000 })
    const scroller = panel.locator('.overflow-y-auto').first()
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBeGreaterThan(150)
    await page.screenshot({ path: testInfo.outputPath('sticky-header-top.png') })

    for (const fraction of [0.5, 1]) {
      await scroller.evaluate((el, f) => el.scrollTo({ top: el.scrollHeight * f }), fraction)
      await page.waitForTimeout(400)
      await page.screenshot({ path: testInfo.outputPath(`sticky-header-scrolled-${fraction}.png`) })
      const [scrollerTop, headerTop] = await Promise.all([
        scroller.evaluate((el) => el.getBoundingClientRect().top),
        header.evaluate((el) => el.getBoundingClientRect().top)
      ])
      expect(Math.abs(headerTop - scrollerTop)).toBeLessThan(1)
      await expect(stop).toBeInViewport()
    }

    // Pressed from the bottom of the list, Stop ends the running task.
    await stop.click()
    await expect(stop).toBeHidden({ timeout: 30_000 })
  })
})
