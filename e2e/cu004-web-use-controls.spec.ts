import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid } from './helpers/launch'

const TASK_ID = 'cu004-web-controls'
const JOURNEY_ID = 'cu004-web-controls-journey'
const MODEL_ID = 'mradermacher/UI-TARS-1.5-7B-GGUF'

let app: ElectronApplication | null = null
let page: Page
let profileDir = ''
let localPage: http.Server | null = null
let localPageUrl = ''
let modelPort = 0

test.describe.configure({ timeout: 180_000 })

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function stageModelBoundary(): void {
  const modelDir = path.join(profileDir, 'models')
  const llamaDir = path.join(profileDir, 'bin', 'llama')
  fs.mkdirSync(modelDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })

  for (const file of ['UI-TARS-1.5-7B-Q4_K_M.gguf', 'mmproj-UI-TARS-1.5-7B-f16.gguf']) {
    const bytes = Buffer.alloc(2_048)
    bytes.write('GGUF')
    fs.writeFileSync(path.join(modelDir, file), bytes)
  }
  fs.writeFileSync(
    path.join(modelDir, 'active-model.json'),
    JSON.stringify({
      id: MODEL_ID,
      primary: 'UI-TARS-1.5-7B-Q4_K_M.gguf',
      mmproj: 'mmproj-UI-TARS-1.5-7B-f16.gguf'
    })
  )

  const executable = path.join(llamaDir, 'llama-server')
  fs.copyFileSync(
    path.join(process.cwd(), 'e2e', 'fixtures', 'cu004-web-use-llama-server.mjs'),
    executable
  )
  fs.chmodSync(executable, 0o755)
}

function seedRetryableTask(): void {
  const now = Date.now()
  const schema = `
    CREATE TABLE task_run_history (
      task_id TEXT PRIMARY KEY, journey_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL, summary TEXT, steps_json TEXT NOT NULL DEFAULT '[]',
      started_at INTEGER NOT NULL, finished_at INTEGER, updated_at INTEGER NOT NULL,
      execution_device_id TEXT, execution_device_name TEXT, phase TEXT, current_step INTEGER,
      current_action TEXT, last_url TEXT, last_title TEXT, screenshot_path TEXT,
      screenshot_device_id TEXT, step_details_json TEXT NOT NULL DEFAULT '[]'
    );
    INSERT INTO task_run_history VALUES (
      ${sql(TASK_ID)}, ${sql(JOURNEY_ID)}, 'web_use', 'Complete the protected web form',
      'failed', 'The prior browser run stopped before the protected step.',
      ${sql(JSON.stringify(['Opened the protected form']))},
      ${now - 60_000}, ${now - 30_000}, ${now - 30_000},
      NULL, NULL, 'failed', 1, 'Retry the browser task',
      ${sql(localPageUrl)}, 'CU-004 Pointer Lab', NULL, NULL, '[]'
    );
  `
  execFileSync('sqlite3', [path.join(profileDir, 'memories.db'), schema])
}

async function startLocalPage(): Promise<void> {
  localPage = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(`<!doctype html><html><head><title>CU-004 Pointer Lab</title>
      <style>
        body{font:20px system-ui;margin:0;background:#f7f7f7;color:#171717;min-height:100vh;overflow:hidden}
        h1{position:fixed;left:8vw;top:5vh;margin:0}
        label{position:fixed;left:8vw;top:20vh;width:36vw}
        input{box-sizing:border-box;display:block;font:inherit;margin-top:12px;padding:14px;width:100%}
        #type-target{position:fixed;left:8vw;top:27vh;width:36vw;height:10vh;margin:0}
        button{position:fixed;left:16vw;top:52vh;width:20vw;height:12vh;font:inherit;padding:14px}
        #status{position:fixed;left:8vw;top:68vh;margin:0}
        #protected-step{position:fixed;left:52vw;top:20vh;width:36vw}
      </style></head><body><h1>Web Use pointer lab</h1>
      <label>Type target<input id="type-target" aria-label="Type target" oninput="document.querySelector('#status').textContent='Typing recorded.'"></label>
      <button id="click-target" onclick="document.querySelector('#status').textContent='Pointer click recorded.'">Click target</button>
      <p id="status">Waiting for the production browser driver.</p>
      <label id="protected-step">Protected account step<input type="password" name="Account password" autocomplete="current-password"></label>
      </body></html>`)
  })
  await new Promise<void>((resolve) => localPage!.listen(0, '127.0.0.1', resolve))
  localPageUrl = `http://127.0.0.1:${(localPage.address() as AddressInfo).port}/`
}

async function gotoChat(): Promise<void> {
  await page.keyboard.press('Meta+K')
  const palette = page.getByRole('dialog', { name: 'Search Off Grid AI' })
  await expect(palette).toBeVisible()
  await palette.getByPlaceholder(/^Search everything/).fill('Chat')
  await page.getByTestId('palette-screen-memory-chat-root').click()
  await expect(
    page.getByRole('heading', { name: 'Start a conversation', exact: true })
  ).toBeVisible()
}

async function taskSnapshot(): Promise<{
  status: string
  summary?: string
  steps: string[]
} | null> {
  return page.evaluate(async (taskId) => {
    const task = (await window.api.tasks.list(50)).find((candidate) => candidate.taskId === taskId)
    return task ? { status: task.status, summary: task.summary, steps: task.steps } : null
  }, TASK_ID)
}

async function waitForTaskStatus(status: string): Promise<void> {
  await expect.poll(async () => (await taskSnapshot())?.status).toBe(status)
}

async function waitForPendingDecision(): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${modelPort}/qa/pending-decision`)
    if (response.ok && Boolean((await response.json()).pending)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const modelState = await fetch(`http://127.0.0.1:${modelPort}/qa/state`).then((response) =>
    response.json()
  )
  throw new Error(
    `The visual decision did not arrive. task=${JSON.stringify(await taskSnapshot())} model=${JSON.stringify(modelState)}`
  )
}

async function releaseDecision(): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${modelPort}/qa/release-decision`, {
    method: 'POST'
  })
  expect(response.ok).toBe(true)
}

async function waitForModelPort(): Promise<void> {
  const portFile = path.join(profileDir, 'qa-model-port')
  await expect.poll(() => fs.existsSync(portFile)).toBe(true)
  modelPort = Number(fs.readFileSync(portFile, 'utf8'))
  expect(modelPort).toBeGreaterThan(0)
}

async function releaseUntilUserHandoff(): Promise<void> {
  for (let decision = 0; decision < 10; decision += 1) {
    await releaseDecision()
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const task = await taskSnapshot()
      if (task?.status === 'waiting') return
      if (task && ['failed', 'stopped'].includes(task.status)) {
        throw new Error(`Web Use ended before user handoff: ${JSON.stringify(task)}`)
      }
      const response = await fetch(`http://127.0.0.1:${modelPort}/qa/pending-decision`)
      if (response.ok && Boolean((await response.json()).pending)) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error(`Web Use did not reach user handoff: ${JSON.stringify(await taskSnapshot())}`)
}

test.beforeAll(async () => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-cu004-web-controls-'))
  await startLocalPage()
  stageModelBoundary()
  seedRetryableTask()

  app = await launchOffGrid({
    cwd: profileDir,
    env: {
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_BIN_DIR: path.join(profileDir, 'bin'),
      OFFGRID_PRO: '1',
      OFFGRID_E2E_HEADLESS: '1',
      OFFGRID_E2E_ISOLATED_INSTANCE: '1'
    }
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => console.error(`[renderer error] ${error.stack ?? error.message}`))
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
  await page.evaluate(() =>
    window.api.saveSetting('computerUseSettings', {
      modelStrategy: 'same_as_chat',
      context: 'auto',
      screenshotSize: 'balanced',
      screenshotQuality: 'balanced',
      checkpointInterval: 9,
      visualHistoryFrames: 2,
      retrieveOlderVisuals: false
    })
  )
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 20, y: 40, width: 1480, height: 900 })
  })
})

test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  await new Promise<void>((resolve) => localPage?.close(() => resolve()) ?? resolve())
  fs.rmSync(profileDir, { recursive: true, force: true })
})

test('runs Web Use through Pause, Take Over, HITL, Resume, and terminal Stop', async ({
  browserName: _browserName
}, testInfo) => {
  await gotoChat()
  await page
    .getByTestId('main-workspace')
    .getByRole('button', { name: /^Tasks(?:,|$)/ })
    .click()
  await expect(page.getByTestId('task-side-panel')).toBeVisible()
  await page.getByTestId(`task-tab-${TASK_ID}`).click()

  await page.evaluate((url) => window.api.browser.openUrl(url), localPageUrl)
  await page.getByRole('tab', { name: 'CU-004 Pointer Lab', exact: true }).last().click()
  await page.getByRole('button', { name: 'Retry failed step' }).click()
  await waitForTaskStatus('running')
  await waitForModelPort()
  await waitForPendingDecision()

  const controls = page.getByTestId('task-live-controls')
  await expect(controls.getByRole('button', { name: 'Pause', exact: true })).toBeVisible()
  await controls.getByRole('button', { name: 'Pause', exact: true }).click()
  await waitForTaskStatus('paused')
  await controls.getByRole('button', { name: 'Resume', exact: true }).click()
  await waitForTaskStatus('running')

  await controls.getByRole('button', { name: 'Take Over', exact: true }).click()
  await waitForTaskStatus('paused')
  await expect(controls.getByRole('button', { name: 'Resume', exact: true })).toBeVisible()
  await controls.getByRole('button', { name: 'Resume', exact: true }).click()
  await waitForTaskStatus('running')

  await releaseUntilUserHandoff()
  await expect(
    page.getByText('Confirm the protected account step yourself.', { exact: true })
  ).toBeVisible()
  await controls.getByRole('button', { name: 'Continue', exact: true }).click()
  await waitForTaskStatus('running')
  await waitForPendingDecision()
  await controls.getByRole('button', { name: 'Stop', exact: true }).click()
  await waitForTaskStatus('stopped')
  await expect(controls.getByRole('button', { name: 'Stop', exact: true })).toBeHidden()
  await page.screenshot({ path: testInfo.outputPath('cu004-terminal-stop.png') })
})
