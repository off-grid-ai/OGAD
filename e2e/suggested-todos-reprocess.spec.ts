/**
 * A to-do read from a captured chat waits in Suggested with its quote; once accepted it survives
 * Re-process today, and a dismissed one is not suggested again.
 *
 * Real capture pipeline, summary and to-do extraction, Actions screen and Re-process today. The
 * boundaries: macOS (the APP-120 native fixture reports the window in front and its pixels) and
 * the local model (a fake llama-server that reads an ask from the captured text).
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { targetIsPackaged } from './helpers/launch'
import { completeOnboarding } from './helpers/onboarding'
import { enginePortsUnavailableReason } from './helpers/ports'
import { closeAndWait } from './helpers/windows'

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))
const DECK = 'Please send the Q3 deck by Friday'
const DINNER = 'Could you book the client dinner for Tuesday'

let app: ElectronApplication | null = null
let page: Page
let userDataDir: string
let controlPath: string

/** The chat in front, as macOS would report it: the window title carries the ask. */
const chatInFront = (ask: string): void => {
  const next = `${controlPath}.next`
  fs.writeFileSync(
    next,
    JSON.stringify({
      permission: 'granted',
      captureMode: 'normal',
      surface: {
        appName: 'Slack',
        windowTitle: `Priya Shah: ${ask}`,
        url: `offgrid-e2e://slack/${encodeURIComponent(ask)}`
      }
    })
  )
  fs.renameSync(next, controlPath)
}

function installModel(): void {
  const modelsDir = path.join(userDataDir, 'models')
  const llamaDir = path.join(userDataDir, 'bin', 'llama')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })
  const gguf = Buffer.alloc(2_048)
  gguf.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'todo.gguf'), gguf)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'todo-capture-model', primary: 'todo.gguf', mmproj: null })
  )
  const executable = path.join(llamaDir, 'llama-server')
  fs.copyFileSync(path.resolve('e2e/fixtures/todo-capture-llama-server.mjs'), executable)
  fs.chmodSync(executable, 0o755)
}

const nav = (name: string): Locator =>
  page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name, exact: true })

const todos = async (status: string): Promise<Locator> => {
  await page
    .getByRole('radiogroup', { name: 'To-do status' })
    .getByRole('radio', { name: new RegExp(`^${status}`) })
    .click()
  return page.getByRole('list', { name: 'To-dos', exact: true })
}

const card = (list: Locator, text: string): Locator =>
  list.getByRole('listitem').filter({ hasText: text })

const captureSettings = async (): Promise<void> => {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
  const section = page.getByRole('button', { name: /^(All settings\s*)?Capture & processing/ })
  if ((await section.getAttribute('aria-expanded')) !== 'true') await section.click()
}

const reprocessToday = async (): Promise<void> => {
  await captureSettings()
  const button = page.getByRole('button', { name: 'Re-process today', exact: true })
  await button.click()
  await expect(button).toBeEnabled({ timeout: 60_000 })
  await page.keyboard.press('Escape')
}

test.describe('Suggested to-dos', () => {
  test.skip(targetIsPackaged(), 'The native capture boundary targets the source-built app.')

  test.beforeEach(async () => {
    test.skip(!PRO_PRESENT, 'pro package not present: to-dos are a Pro surface')
    const busy = await enginePortsUnavailableReason()
    test.skip(busy !== null, busy ?? '')
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-suggested-todos-'))
    controlPath = path.join(userDataDir, 'native-control.json')
    installModel()
    chatInFront(DECK)
    app = await electron.launch({
      args: [path.resolve('e2e/fixtures/app120-app122-capture-privacy-native-boundary.cjs')],
      env: {
        ...process.env,
        OFFGRID_USER_DATA: userDataDir,
        OFFGRID_BIN_DIR: path.join(userDataDir, 'bin'),
        OFFGRID_TODO_MODEL_LOG: path.join(userDataDir, 'model-requests.jsonl'),
        OFFGRID_APP120_APP122_NATIVE_LEDGER: path.join(userDataDir, 'native-ledger.jsonl'),
        OFFGRID_APP120_APP122_NATIVE_CONTROL: controlPath,
        OFFGRID_PRO: '1',
        NODE_ENV: 'production',
        NO_PROXY: '127.0.0.1,localhost'
      }
    })
    page = await app.firstWindow()
    await completeOnboarding(page)
  })

  // Playwright requires the first callback argument to use object destructuring.
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    if (app) await closeAndWait(app)
    app = null
    for (const log of ['model-requests.jsonl', 'native-ledger.jsonl']) {
      const file = path.join(userDataDir, log)
      if (fs.existsSync(file)) fs.copyFileSync(file, testInfo.outputPath(log))
    }
    fs.rmSync(userDataDir, { recursive: true, force: true })
  })

  test('accepted survives Re-process today; dismissed is not suggested again', async () => {
    test.setTimeout(300_000)
    await captureSettings()
    await page.getByRole('button', { name: 'Resume capture' }).click()
    await page.keyboard.press('Escape')

    // Priya's ask is read from the chat and waits in Suggested, with her words.
    await nav('Actions').click()
    let suggested = await todos('suggested')
    await expect(card(suggested, 'Send the Q3 deck')).toBeVisible({ timeout: 90_000 })
    await card(suggested, 'Send the Q3 deck')
      .getByRole('button', { name: 'Send the Q3 deck', exact: true })
      .click()
    await expect(card(suggested, 'Send the Q3 deck')).toContainText(DECK)
    await card(suggested, 'Send the Q3 deck').getByRole('button', { name: 'Accept' }).click()
    await expect(card(await todos('open'), 'Send the Q3 deck')).toBeVisible()

    // A second ask comes in well inside the 45 s between to-do scans. It waits for the next scan
    // instead of being missed, then is dismissed.
    chatInFront(DINNER)
    suggested = await todos('suggested')
    await expect(card(suggested, 'Book the client dinner')).toBeVisible({ timeout: 120_000 })
    const dinner = card(suggested, 'Book the client dinner')
    await dinner.getByRole('button', { name: 'Dismiss', exact: true }).first().click()
    await dinner.getByRole('button', { name: 'Dismiss', exact: true }).last().click()
    await expect(card(await todos('dismissed'), 'Book the client dinner')).toBeVisible()

    // Re-process today reads the day again: the accepted to-do stays open, the dismissed one stays
    // dismissed and is not suggested again.
    await reprocessToday()
    await nav('Actions').click()
    await expect(card(await todos('open'), 'Send the Q3 deck')).toBeVisible()
    await expect(card(await todos('suggested'), 'Book the client dinner')).toHaveCount(0)
    await expect(card(await todos('dismissed'), 'Book the client dinner')).toBeVisible()
    await reprocessToday()
    await nav('Actions').click()
    await expect(card(await todos('open'), 'Send the Q3 deck')).toBeVisible()
    await expect(card(await todos('suggested'), 'Book the client dinner')).toHaveCount(0)
  })
})
