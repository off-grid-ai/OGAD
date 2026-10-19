/**
 * A web task stopped while it waits never starts, and Continue runs it after all.
 *
 * Real app, real Web Use host, task queue and task cards; the boundaries are the fake paired
 * browser and a fake llama-server that holds a task whose goal says "slowly" and finishes any
 * other. Chat A starts a slow web task; chat B asks for another, which has to wait for the
 * browser. B is stopped while it waits, A is stopped, and B must still not start. Continue on B's
 * card then runs it to the end.
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
const SLOW = 'Read the headline slowly in my browser.'
const QUICK = 'Read the headline of the page in my browser.'

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let modelLog: string
let browser: FakeExtension | null = null

interface TaskRow {
  taskId: string
  title: string
  status: string
}

const tasks = (): Promise<TaskRow[]> =>
  page.evaluate(async () => (await window.api.tasks.list(20)) as TaskRow[])

const taskFor = async (goal: RegExp): Promise<TaskRow | undefined> =>
  (await tasks()).find((task) => goal.test(task.title))

/** How many page steps the model was asked to decide for tasks matching `goal`. */
const stepsFor = (goal: RegExp): number =>
  (fs.existsSync(modelLog) ? fs.readFileSync(modelLog, 'utf8').split('\n') : []).filter(
    (line) => line.includes('You control one visible browser page') && goal.test(line)
  ).length

const ask = async (question: string): Promise<void> => {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await composer.fill(question)
  await composer.press('Enter')
}

test.describe('A queued web task and Stop', () => {
  test.skip(targetIsPackaged(), 'This native-model boundary is for the source-built E2E target.')

  test.beforeEach(async () => {
    test.skip(!PRO_PRESENT, 'pro package not present: Web Use is a Pro surface')
    const busy = await enginePortsUnavailableReason()
    test.skip(busy !== null, busy ?? '')
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-web-task-queue-'))
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
        OFFGRID_PRO: '1',
        NODE_ENV: 'production',
        NO_PROXY: '127.0.0.1,localhost'
      }
    })
    page = await mainWindow(app)
    await completeOnboarding(page)
    browser = await pairedBrowser(app)
    browser.answers.set('page.call', (command) => ({
      text:
        command.args.tool === 'browser_snapshot'
          ? '- Page URL: https://example.test/\n- Page Title: Harbour News\n- Page Snapshot:\n```yaml\n- heading "Harbour News" [level=1] [ref=e2]\n```'
          : 'Done.',
      isError: false
    }))
    // Settings → Tasks → Web Use: the default browser.
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await page.getByRole('button', { name: 'Active models', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).last().click()
    await page.getByRole('radio', { name: 'tasks', exact: true }).click()
    await page.getByRole('combobox', { name: 'Web Use browser' }).click()
    await page.getByRole('option', { name: 'Default browser', exact: true }).click()
    await expect(page.getByText('Connected: E2E Browser.', { exact: false })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
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

  test('A stopped queued task never starts; Continue runs it to the end', async () => {
    test.setTimeout(180_000)
    // Chat A's task is reading the page, slowly.
    await ask(SLOW)
    await expect.poll(() => stepsFor(/slowly/), { timeout: 60_000 }).toBeGreaterThan(0)

    // Chat B asks for another: it has to wait for the browser. The running task fills the
    // window, so close Tasks first.
    await page.getByRole('banner').getByRole('button', { name: 'Close Tasks' }).click()
    await page
      .getByRole('complementary')
      .getByRole('button', { name: 'New chat', exact: true })
      .click()
    await ask(QUICK)
    const quick = /^(?!.*slowly).*headline/i
    await expect.poll(async () => (await taskFor(quick))?.status, { timeout: 60_000 }).toBeDefined()
    const waiting = (await taskFor(quick))!.taskId
    const tasksPanel = page.getByRole('region', { name: 'Tasks' })
    await expect(tasksPanel.getByText('Read the headline of the page in my browser')).toBeVisible()
    expect(stepsFor(quick)).toBe(0)

    // Stop the waiting task, then stop the slow one so the browser is free.
    await tasksPanel.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect
      .poll(async () => (await tasks()).find((task) => task.taskId === waiting)?.status, {
        timeout: 30_000
      })
      .toBe('stopped')
    // Chat A's Tasks show the slow task; stop it there.
    await page.getByRole('banner').getByRole('button', { name: 'Close Tasks' }).click()
    const showList = page.getByRole('button', { name: 'Show conversations', exact: true })
    if (await showList.isVisible()) await showList.click()
    await page
      .getByRole('complementary')
      .getByRole('button', { name: /^Read the headline slowly/ })
      .first()
      .click()
    await page.getByRole('banner').getByRole('button', { name: /Tasks/ }).click()
    await tasksPanel.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect
      .poll(async () => (await taskFor(/slowly/))?.status, { timeout: 30_000 })
      .toBe('stopped')

    // With the browser free, the stopped task still does not start.
    await page.waitForTimeout(5_000)
    expect((await tasks()).find((task) => task.taskId === waiting)?.status).toBe('stopped')
    expect(stepsFor(quick)).toBe(0)

    // Continue on chat B's task card runs it to the end.
    await page.getByRole('banner').getByRole('button', { name: 'Close Tasks' }).click()
    await page
      .getByRole('complementary')
      .getByRole('button', { name: /^Read the headline of the page/ })
      .first()
      .click()
    await expect(
      page.getByText('Task stopped: Web Use stopped: stopped before it started').last()
    ).toBeVisible()
    await page.getByRole('button', { name: 'Work done', exact: true }).last().click()
    // The person stopped it, so the step reads Stopped, not failed, and offers Continue.
    const step = page.getByRole('list', { name: 'Tool calls' }).last().getByRole('alert')
    await expect(step.getByText('Stopped', { exact: true })).toBeVisible()
    await expect(step.getByText('Failed', { exact: true })).toHaveCount(0)
    await step.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await tasks()).some((task) => quick.test(task.title) && task.status === 'done'),
        { timeout: 60_000 }
      )
      .toBe(true)
    expect(stepsFor(quick)).toBeGreaterThan(0)
  })
})
