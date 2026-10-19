/**
 * Web Use runs in the paired browser when the person chose their default browser.
 *
 * Real app, real Web Use host and task loop; the boundaries are the fake paired browser (which
 * answers the page tools for its tab) and a fake llama-server that asks for a web task in chat,
 * plans it, and finishes when the page shows the headline.
 *
 * Asserts: with Web Use set to the default browser and a browser connected, a web task asked for
 * in Desktop chat opens a tab in that browser and reads the page there (page.call on that tab),
 * and the answer comes back to chat; Stop on a running task reaches the browser and ends the task;
 * once the browser goes away, Settings says tasks fall back to the Off Grid AI browser.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { enginePortsUnavailableReason } from './helpers/ports'
import { pairedBrowser, type FakeExtension } from './helpers/fake-extension'
import { closeAndWait, mainWindow } from './helpers/windows'

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))
const HEADLINE = 'Harbour News'
const ASK = 'Read the headline of the page in my browser.'

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let modelLog: string
let browser: FakeExtension | null = null

const launch = async (hold: boolean): Promise<void> => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-browser-web-task-'))
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
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_BIN_DIR: path.join(profileDir, 'bin'),
      OFFGRID_WEB_TASK_LOG: modelLog,
      ...(hold ? { OFFGRID_WEB_TASK_HOLD: '1' } : {}),
      OFFGRID_PRO: '1',
      NODE_ENV: 'production',
      NO_PROXY: '127.0.0.1,localhost'
    }
  })
  page = await mainWindow(app)
  await completeOnboarding(page)
  browser = await pairedBrowser(app)
  // The browser's tab shows a news page; the page tools read it from there.
  browser.answers.set('page.call', (command) => ({
    text:
      command.args.tool === 'browser_snapshot'
        ? `- Page URL: https://example.test/\n- Page Title: ${HEADLINE}\n- Page Snapshot:\n\`\`\`yaml\n- heading "${HEADLINE}" [level=1] [ref=e2]\n- paragraph [ref=e3]: Boats return at dusk.\n\`\`\``
        : 'Done.',
    isError: false
  }))
}

/** Settings → Tasks → Web Use browser: the default browser. Returns the hint under it. */
const chooseDefaultBrowser = async (): Promise<void> => {
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await page.getByRole('button', { name: 'Active models', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).last().click()
  await page.getByRole('radio', { name: 'tasks', exact: true }).click()
  await page.getByRole('combobox', { name: 'Web Use browser' }).click()
  await page.getByRole('option', { name: 'Default browser', exact: true }).click()
  await expect(page.getByText('Connected: E2E Browser.', { exact: false })).toBeVisible({
    timeout: 15_000
  })
}

const closeSettings = async (): Promise<void> => {
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
}

const ask = async (): Promise<void> => {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await composer.fill(ASK)
  await composer.press('Enter')
}

/** The tab the browser opened or handed over for the task. */
const taskTab = (): number | undefined => {
  const opened = browser!.commands.find(
    (command) => command.op === 'tab.create' || command.op === 'tab.adopt'
  )
  if (!opened) return undefined
  return opened.op === 'tab.adopt'
    ? Number(opened.args.tabId)
    : browser!.tabs[browser!.tabs.length - 1]!.tabId
}

test.describe('Web Use in the paired browser', () => {
  test.skip(targetIsPackaged(), 'This native-model boundary is for the source-built E2E target.')

  test.beforeEach(async () => {
    test.skip(!PRO_PRESENT, 'pro package not present: Web Use is a Pro surface')
    const busy = await enginePortsUnavailableReason()
    test.skip(busy !== null, busy ?? '')
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

  test('A web task asked for in chat reads the page in the paired browser', async () => {
    test.setTimeout(150_000)
    await launch(false)
    await chooseDefaultBrowser()
    await closeSettings()
    await ask()

    await expect.poll(taskTab, { timeout: 60_000 }).toBeDefined()
    const tab = taskTab()!
    await expect
      .poll(
        () =>
          browser!.commands.some(
            (command) => command.op === 'page.call' && command.args.tabId === tab
          ),
        { timeout: 60_000 }
      )
      .toBe(true)
    // The task's result comes back to the chat that asked for it.
    await expect(page.getByText('Web Use done', { exact: true }).first()).toBeVisible({
      timeout: 60_000
    })
    await expect(page.getByText(`The headline is ${HEADLINE}.`).first()).toBeVisible()

    // Without the browser, Settings says where tasks run instead.
    await browser!.close()
    await page.getByRole('button', { name: 'Active models', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).last().click()
    await page.getByRole('radio', { name: 'tasks', exact: true }).click()
    await expect(page.getByText('Waiting for your browser.', { exact: false })).toBeVisible({
      timeout: 15_000
    })
    await expect(
      page.getByText('Until it connects, tasks run in the Off Grid AI browser.', { exact: false })
    ).toBeVisible()
  })

  test('Stop on a running web task reaches the paired browser', async () => {
    test.setTimeout(150_000)
    await launch(true)
    await chooseDefaultBrowser()
    await closeSettings()
    await ask()

    // The task is reading the page in the browser's tab when Stop is pressed.
    await expect
      .poll(() => browser!.commands.some((command) => command.op === 'page.call'), {
        timeout: 60_000
      })
      .toBe(true)
    await expect
      .poll(
        () =>
          fs.existsSync(modelLog) &&
          fs.readFileSync(modelLog, 'utf8').includes('You control one visible browser page'),
        { timeout: 60_000 }
      )
      .toBe(true)
    const sentBeforeStop = browser!.commands.length
    // The running task opens in the Tasks panel with its controls.
    await page
      .getByRole('region', { name: 'Tasks' })
      .getByRole('button', { name: 'Stop', exact: true })
      .click()

    await expect
      .poll(
        () =>
          browser!.commands
            .slice(sentBeforeStop)
            .some((command) => command.op === 'cdp.detach' || command.op === 'tab.close'),
        { timeout: 30_000 }
      )
      .toBe(true)
    await expect
      .poll(
        () =>
          page.evaluate(async () =>
            (await window.api.tasks.list(10)).map((task: { status: string }) => task.status)
          ),
        { timeout: 30_000 }
      )
      .toContain('stopped')
  })
})
