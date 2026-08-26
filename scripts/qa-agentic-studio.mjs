/* eslint-disable @typescript-eslint/explicit-function-return-type -- JavaScript QA harness */
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import {
  createEvidenceProfile,
  evidenceEnvironment,
  removeEvidenceProfile
} from './release-evidence-profile.mjs'

const evidenceDir = path.resolve('e2e/screenshots/agentic-studio')
mkdirSync(evidenceDir, { recursive: true })
const profile = createEvidenceProfile('agentic-studio')
const dbPath = path.join(profile, 'memories.db')
const now = Date.now()

const localPage = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' })
  response.end(`<!doctype html>
    <html><head><title>CU-004 Pointer Lab</title>
    <style>
      body{font:20px system-ui;margin:0;background:#f7f7f7;color:#171717;min-height:100vh;overflow:hidden}
      h1{position:fixed;left:8vw;top:5vh;margin:0}
      label{position:fixed;left:8vw;top:20vh;width:36vw}
      input{box-sizing:border-box;display:block;font:inherit;margin-top:12px;padding:14px;width:100%}
      #type-target{position:fixed;left:8vw;top:27vh;width:36vw;height:10vh;margin:0}
      button{position:fixed;left:16vw;top:52vh;width:20vw;height:12vh;font:inherit;padding:14px}
      #status{position:fixed;left:8vw;top:68vh;margin:0}
      #protected-step{position:fixed;left:52vw;top:20vh;width:36vw}
    </style>
    </head><body><h1>Web Use pointer lab</h1>
    <label>Type target<input id="type-target" aria-label="Type target" oninput="document.querySelector('#status').textContent='Typing recorded.'"></label>
    <button id="click-target" onclick="document.querySelector('#status').textContent='Pointer click recorded.'">Click target</button>
    <p id="status">Waiting for the production browser driver.</p>
    <label id="protected-step">Protected account step<input type="password" name="Account password" autocomplete="current-password"></label>
    </body></html>`)
})
await new Promise((resolve) => localPage.listen(0, '127.0.0.1', resolve))
const localAddress = localPage.address()
if (!localAddress || typeof localAddress === 'string')
  throw new Error('Local CU-004 page did not bind')
const localPageUrl = `http://127.0.0.1:${localAddress.port}/`

const modelDir = path.join(profile, 'models')
const llamaDir = path.join(profile, 'bin', 'llama')
mkdirSync(modelDir, { recursive: true })
mkdirSync(llamaDir, { recursive: true })
const gguf = Buffer.alloc(2_048)
gguf.write('GGUF')
const primaryModel = 'UI-TARS-1.5-7B-Q4_K_M.gguf'
const projectorModel = 'mmproj-UI-TARS-1.5-7B-f16.gguf'
writeFileSync(path.join(modelDir, primaryModel), gguf)
writeFileSync(path.join(modelDir, projectorModel), gguf)
writeFileSync(
  path.join(modelDir, 'active-model.json'),
  JSON.stringify({
    id: 'mradermacher/UI-TARS-1.5-7B-GGUF',
    primary: primaryModel,
    mmproj: projectorModel
  })
)
const llamaExecutable = path.join(llamaDir, 'llama-server')
copyFileSync(path.resolve('e2e/fixtures/cu004-web-use-llama-server.mjs'), llamaExecutable)
chmodSync(llamaExecutable, 0o755)

const stepDetails = JSON.stringify([
  {
    stepId: 'observe-dashboard',
    at: now - 42_000,
    phase: 'checking',
    modelInput: 'Find the newest failed deployment and open its details.',
    retrievedFacts: ['The build list is sorted newest first.', 'One build is marked failed.'],
    tokenUsage: { input: 1184, output: 96, context: 2048 },
    decisionSummary: 'Opened the newest failed deployment.',
    modelOutput: '{"action":"click","target":"build-482"}',
    mappedAction: 'click at 917, 284',
    execution: { status: 'complete', durationMs: 326, result: 'Deployment details opened.' }
  },
  {
    stepId: 'read-error',
    at: now - 31_000,
    phase: 'complete',
    decisionSummary: 'Found the failing migration and copied its error.',
    mappedAction: 'copy text from deployment log',
    execution: { status: 'complete', durationMs: 448, result: 'Error copied to clipboard.' }
  }
])

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
const rows = [
  [
    'computer-complete',
    'chat-demo-journey',
    'computer_use',
    'Inspect the failed deployment',
    'done',
    'The failed database migration is ready to review.',
    JSON.stringify(['Opened deployment dashboard', 'Selected build 482', 'Copied migration error']),
    now - 60_000,
    now - 20_000,
    now - 20_000,
    'desktop:qa-mac',
    'QA Mac',
    'complete',
    3,
    'Finished',
    null,
    null,
    null,
    null,
    stepDetails
  ],
  [
    'web-failed',
    'chat-browser-journey',
    'web_use',
    'Compare local-first note apps',
    'failed',
    'The browser task stopped after the page changed.',
    JSON.stringify([
      'Opened the comparison page',
      'Read the privacy table',
      'Page changed before the final check'
    ]),
    now - 120_000,
    now - 70_000,
    now - 70_000,
    null,
    null,
    'failed',
    3,
    'Page changed before the final check',
    localPageUrl,
    'CU-004 Pointer Lab',
    null,
    null,
    '[]'
  ],
  [
    'web-complete',
    'chat-research-journey',
    'web_use',
    'Read the release notes',
    'done',
    'The release notes were checked.',
    JSON.stringify(['Opened release notes', 'Read the compatibility section']),
    now - 240_000,
    now - 190_000,
    now - 190_000,
    null,
    null,
    'complete',
    2,
    'Finished',
    'https://example.com/',
    'Example Domain',
    null,
    null,
    '[]'
  ]
]

const schema = `
CREATE TABLE task_run_history (
  task_id TEXT PRIMARY KEY, journey_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL, summary TEXT, steps_json TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL, finished_at INTEGER, updated_at INTEGER NOT NULL,
  execution_device_id TEXT, execution_device_name TEXT, phase TEXT, current_step INTEGER,
  current_action TEXT, last_url TEXT, last_title TEXT, screenshot_path TEXT,
  screenshot_device_id TEXT, step_details_json TEXT NOT NULL DEFAULT '[]'
);
${rows
  .map(
    (row) =>
      `INSERT INTO task_run_history VALUES (${row.map((value) => (value === null ? 'NULL' : quote(value))).join(',')});`
  )
  .join('\n')}
`
execFileSync('sqlite3', [dbPath, schema])

let app
let nativeWindowId = ''
let modelPort = 0
const evidence = []
const shot = async (page, name) => {
  const target = path.join(evidenceDir, `${name}.png`)
  await page.screenshot({ path: target })
  evidence.push(target)
  console.log(`SHOT ${target}`)
}
const nativeShot = (name) => {
  nativeWindowId = execFileSync('swift', [
    path.resolve('scripts/cg-window-id.swift'),
    String(app.process().pid)
  ])
    .toString()
    .trim()
  if (!nativeWindowId) throw new Error('Native Electron window ID is unavailable')
  const target = path.join(evidenceDir, `${name}.png`)
  try {
    execFileSync('screencapture', ['-x', `-l${nativeWindowId}`, target])
  } catch (error) {
    console.warn(
      `NATIVE SHOT unavailable (grant Screen Recording permission to capture it): ${error instanceof Error ? error.message : String(error)}`
    )
    return
  }
  evidence.push(target)
  console.log(`SHOT ${target}`)
}
const waitForShellLayout = async (page, layout) => {
  const sidebarControl = layout.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'
  const absentSidebarControl = layout.sidebarCollapsed ? 'Collapse sidebar' : 'Expand sidebar'
  const mainControl = layout.mainCollapsed ? 'Show main workspace' : 'Hide main workspace'
  const absentMainControl = layout.mainCollapsed ? 'Hide main workspace' : 'Show main workspace'
  await page.getByRole('button', { name: sidebarControl }).waitFor()
  await page.getByRole('button', { name: mainControl }).waitFor()
  await page.getByRole('button', { name: absentSidebarControl }).waitFor({ state: 'detached' })
  await page.getByRole('button', { name: absentMainControl }).waitFor({ state: 'detached' })
  await page.waitForFunction(
    ({ collapsed }) => {
      const workspace = document.querySelector('[data-testid="main-workspace"]')
      if (!workspace) return false
      const width = workspace.getBoundingClientRect().width
      return collapsed ? width <= 1 : width >= 200
    },
    { collapsed: layout.mainCollapsed },
    { timeout: 5_000 }
  )
  const mainWidth = await page
    .getByTestId('main-workspace')
    .evaluate((workspace) => workspace.getBoundingClientRect().width)
  console.log(
    `SHELL sidebar=${layout.sidebarCollapsed ? 'collapsed' : 'expanded'} chat=${layout.mainCollapsed ? 'collapsed' : 'expanded'} mainWidth=${mainWidth}`
  )
}
const openSidebarDestination = async (page, group, destination) => {
  const destinationButton = page.getByRole('button', { name: destination, exact: true })
  if (!(await destinationButton.isVisible())) {
    await page.getByRole('button', { name: group, exact: true }).click()
  }
  await destinationButton.click()
}
const waitForPendingDecision = async () => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${modelPort}/qa/pending-decision`)
    if ((await response.json()).pending) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const state = await fetch(`http://127.0.0.1:${modelPort}/qa/state`).then((response) =>
    response.json()
  )
  throw new Error(
    `The deterministic model did not request its next decision: ${JSON.stringify(state)}`
  )
}
const releaseDecision = async () => {
  const response = await fetch(`http://127.0.0.1:${modelPort}/qa/release-decision`, {
    method: 'POST'
  })
  if (!response.ok) throw new Error('The deterministic model decision could not be released')
}
const waitForTaskStep = async (page, taskId, expectedStep) =>
  page.waitForFunction(
    async ({ taskId, expectedStep }) => {
      const task = (await window.api.tasks.list(50)).find(
        (candidate) => candidate.taskId === taskId
      )
      return task?.steps.some((step) => step.includes(expectedStep))
    },
    { taskId, expectedStep }
  )
const readModelState = async () => {
  const response = await fetch(`http://127.0.0.1:${modelPort}/qa/state`)
  if (!response.ok) throw new Error('The deterministic model state could not be read')
  return response.json()
}
const readNativePointer = async () =>
  app.evaluate(async ({ BrowserWindow }, expectedUrl) => {
    const win = BrowserWindow.getAllWindows()[0]
    const view = win?.contentView.children.findLast(
      (candidate) =>
        'webContents' in candidate && candidate.webContents.getURL().startsWith(String(expectedUrl))
    )
    if (!view || !('webContents' in view)) return null
    return view.webContents.executeJavaScript(`(() => {
      const pointer = document.getElementById('__offgrid_agent_pointer__')
      const status = document.querySelector('#status')?.textContent ?? ''
      const activeElement = document.activeElement?.id ?? ''
      const inputValue = document.querySelector('#type-target')?.value ?? ''
      if (!pointer) return { visible: false, status, activeElement, inputValue }
      const rect = pointer.getBoundingClientRect()
      return { visible: rect.width > 0 && rect.height > 0, left: rect.left, top: rect.top, status, activeElement, inputValue }
    })()`)
  }, localPageUrl)
const setNativePageTheme = async (theme) =>
  app.evaluate(
    async ({ BrowserWindow }, { expectedUrl, theme }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const view = win?.contentView.children.findLast(
        (candidate) =>
          'webContents' in candidate &&
          candidate.webContents.getURL().startsWith(String(expectedUrl))
      )
      if (!view || !('webContents' in view))
        throw new Error('The native Web Use view is unavailable')
      return view.webContents.executeJavaScript(`(() => {
      document.body.style.background = ${JSON.stringify(theme === 'dark' ? '#111111' : '#f7f7f7')}
      document.body.style.color = ${JSON.stringify(theme === 'dark' ? '#f7f7f7' : '#171717')}
    })()`)
    },
    { expectedUrl: localPageUrl, theme }
  )
const waitForNativePointer = async (expectedStatus) => {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const state = await readNativePointer()
    if (state?.visible && (!expectedStatus || state.status === expectedStatus)) return state
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`The native Web Use pointer did not recover for ${expectedStatus ?? 'the page'}`)
}

try {
  app = await electron.launch({
    args: ['.'],
    env: evidenceEnvironment({
      profile,
      extra: {
        OFFGRID_E2E_HEADLESS: process.env.OFFGRID_E2E_HEADLESS ?? '1',
        OFFGRID_E2E_ISOLATED_INSTANCE: '1',
        OFFGRID_BIN_DIR: path.join(profile, 'bin')
      }
    })
  })
  const page = await app.firstWindow()
  page.on('console', (message) => console.log(`[renderer:${message.type()}] ${message.text()}`))
  page.on('pageerror', (error) => console.error(`[renderer:error] ${error.stack ?? error.message}`))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForURL((url) => url.protocol === 'file:')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.setBounds({ x: 20, y: 40, width: 1480, height: 900 })
  })
  nativeWindowId = execFileSync('swift', [
    path.resolve('scripts/cg-window-id.swift'),
    String(app.process().pid)
  ])
    .toString()
    .trim()
  await page.evaluate(() => {
    localStorage.setItem('onboarding_completed', 'true')
    localStorage.setItem('og-theme', 'dark')
  })
  await page.reload()
  await openSidebarDestination(page, 'Work', 'Chat')
  await page.getByRole('heading', { name: 'Start a conversation', exact: true }).waitFor()
  await page
    .getByTestId('main-workspace')
    .getByRole('button', { name: /^Tasks(?:,|$)/ })
    .click()
  await page.getByTestId('task-side-panel').waitFor()
  await shot(page, '01-chat-tasks-docked-dark')

  await page.getByTestId('task-tab-computer-complete').click()
  await page.getByTestId('task-details-computer-complete').waitFor()
  await page.getByRole('button', { name: /Computer Use step 1:/ }).click()
  await page.getByText('Deployment details opened.').waitFor()
  await shot(page, '02-task-detail-step-expanded')
  await page.getByRole('button', { name: 'Back to Task History' }).click()
  await page.getByTestId('task-tab-web-failed').waitFor()
  await shot(page, '03-task-history-after-back')

  await page.getByTestId('task-tab-web-failed').click()
  const retryButton = page.getByRole('button', { name: 'Retry failed step' })
  await retryButton.waitFor()
  await waitForShellLayout(page, { sidebarCollapsed: false, mainCollapsed: false })
  await page.getByRole('tab', { name: 'CU-004 Pointer Lab', exact: true }).last().click()
  await page.waitForFunction(
    (expectedUrl) =>
      window.api.browser.getSessions().then((state) => {
        const active = state.sessions.find((session) => session.sessionId === state.activeSessionId)
        return active?.url === expectedUrl
      }),
    localPageUrl
  )
  await retryButton.click()
  const modelPortFile = path.join(profile, 'qa-model-port')
  await page.waitForFunction(() =>
    window.api.tasks.list(50).then((tasks) => tasks.some((task) => task.status === 'running'))
  )
  const portDeadline = Date.now() + 10_000
  while (!existsSync(modelPortFile) && Date.now() < portDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (!existsSync(modelPortFile)) throw new Error('The isolated model did not publish its port')
  modelPort = Number(readFileSync(modelPortFile, 'utf8'))
  await waitForPendingDecision()
  // Retrying replaces the browser task session. Re-select the seeded local tab
  // after that replacement so the approved action executes against the same
  // fixed viewport that produced the test evidence.
  await page.getByRole('tab', { name: 'CU-004 Pointer Lab', exact: true }).last().click()
  await page.waitForFunction(
    (expectedUrl) =>
      window.api.browser.getSessions().then((state) => {
        const active = state.sessions.find((session) => session.sessionId === state.activeSessionId)
        return active?.url === expectedUrl
      }),
    localPageUrl
  )
  await page.waitForFunction(async () => {
    const tasks = await window.api.tasks.list(50)
    return tasks.some((task) => task.taskId === 'web-failed' && task.status === 'running')
  })
  const attempts = await page.evaluate(async () =>
    (await window.api.tasks.list(50)).filter((task) => task.journeyId === 'chat-browser-journey')
  )
  console.log(
    `RETRY ${JSON.stringify(attempts.map(({ taskId, status, summary }) => ({ taskId, status, summary })))}`
  )
  await page.getByTestId('task-details-web-failed').waitFor()
  await waitForShellLayout(page, { sidebarCollapsed: true, mainCollapsed: true })
  await shot(page, '04-web-use-start-immersive-detail')

  const retryAttempt = attempts.find((task) => task.taskId === 'web-failed')
  if (!retryAttempt || attempts.length !== 1) {
    throw new Error('Retry did not resume the same CU-004 task record')
  }
  await page.getByLabel('Off Grid AI pointer').waitFor()
  const initialPointer = await readNativePointer()
  if (!initialPointer?.visible)
    throw new Error('Web Use pointer was absent before the first action')
  console.log(`POINTER initial=${JSON.stringify(initialPointer)}`)
  await page.getByRole('button', { name: 'Reload page' }).click()
  const reloadedPointer = await waitForNativePointer('Waiting for the production browser driver.')
  console.log(`POINTER reload=${JSON.stringify(reloadedPointer)}`)
  nativeShot('04a-web-use-pointer-initial-native-window')

  // One strict visual response approves one action. The graph then captures
  // fresh evidence and asks the same judge to complete the milestone.
  await releaseDecision()
  await waitForPendingDecision()
  await waitForTaskStep(page, retryAttempt.taskId, 'click at (')
  const focusedPointer = await readNativePointer()
  if (!focusedPointer?.visible || focusedPointer.activeElement !== 'type-target') {
    throw new Error(`Web Use did not focus the text field: ${JSON.stringify(focusedPointer)}`)
  }
  console.log(`POINTER focused=${JSON.stringify(focusedPointer)}`)

  await releaseDecision()
  await waitForPendingDecision()
  await waitForTaskStep(page, retryAttempt.taskId, 'type text')
  const typingPointer = await readNativePointer()
  if (
    !typingPointer?.visible ||
    typingPointer.status !== 'Typing recorded.' ||
    typingPointer.inputValue !== 'cursor stays visible'
  ) {
    throw new Error('Web Use pointer disappeared between typing and the next action')
  }
  console.log(`POINTER between=${JSON.stringify(typingPointer)}`)
  nativeShot('04b-web-use-pointer-between-actions-native-window')

  await releaseDecision()
  await waitForPendingDecision()
  await waitForTaskStep(page, retryAttempt.taskId, 'milestone complete: Enter the requested text')

  await releaseDecision()
  await waitForPendingDecision()
  await waitForTaskStep(page, retryAttempt.taskId, 'click at (')
  const clickedPointer = await waitForNativePointer('Pointer click recorded.')
  console.log(`POINTER clicked=${JSON.stringify(clickedPointer)}`)

  await releaseDecision()
  await waitForPendingDecision()
  await waitForTaskStep(page, retryAttempt.taskId, 'milestone complete: Click the target')

  await releaseDecision()
  await page.waitForFunction(async (taskId) => {
    const task = (await window.api.tasks.list(50)).find((candidate) => candidate.taskId === taskId)
    return task?.status === 'waiting' || task?.status === 'failed'
  }, retryAttempt.taskId)
  const takeoverState = await page.evaluate(async (taskId) => {
    const task = (await window.api.tasks.list(50)).find((candidate) => candidate.taskId === taskId)
    return task ? { status: task.status, summary: task.summary, steps: task.steps } : null
  }, retryAttempt.taskId)
  console.log(`TAKEOVER ${JSON.stringify(takeoverState)}`)
  if (takeoverState?.status !== 'waiting') throw new Error('Web Use did not enter takeover')
  await page.getByText('Your turn', { exact: true }).waitFor()
  await page
    .getByTestId('task-live-pane')
    .getByText('Confirm the protected account step yourself.', { exact: true })
    .waitFor()
  await shot(page, '04b-web-use-pointer-and-takeover')
  nativeShot('04c-web-use-pointer-and-takeover-native-window')
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await waitForPendingDecision()
  await releaseDecision()
  await page.waitForFunction(async (taskId) => {
    const task = (await window.api.tasks.list(50)).find((candidate) => candidate.taskId === taskId)
    return task?.status === 'failed' && task.summary?.includes('CU-004 terminal model failure')
  }, retryAttempt.taskId)
  const modelState = await readModelState()
  console.log(`MODEL ${JSON.stringify(modelState)}`)
  if (modelState.visualRequestCount !== 7 || modelState.lastAudit?.valid !== true) {
    throw new Error(`The canonical visual request audit failed: ${JSON.stringify(modelState)}`)
  }
  const terminalDetails = page.getByTestId(`task-details-${retryAttempt.taskId}`)
  await terminalDetails.waitFor()
  await terminalDetails
    .getByText('Visual decision failed: LLM Server Error: 500 CU-004 terminal model failure', {
      exact: true
    })
    .waitFor()
  await waitForShellLayout(page, { sidebarCollapsed: false, mainCollapsed: false })
  const terminalPointer = await readNativePointer()
  if (!terminalPointer?.visible) throw new Error('Web Use pointer disappeared after task failure')
  console.log(`POINTER terminal=${JSON.stringify(terminalPointer)}`)
  await shot(page, '04d-web-use-terminal-shell-restored')
  nativeShot('04e-web-use-pointer-terminal-failure-native-window')
  await setNativePageTheme('dark')
  const darkPagePointer = await readNativePointer()
  if (!darkPagePointer?.visible) throw new Error('Web Use pointer disappeared on a dark page')
  console.log(`POINTER dark=${JSON.stringify(darkPagePointer)}`)
  nativeShot('04f-web-use-pointer-terminal-dark-page-native-window')
  await page.getByRole('region', { name: 'Task execution plan' }).waitFor()
  await page.getByText('Enter the requested text', { exact: true }).waitFor()
  await shot(page, '04g-web-use-execution-plan-detail')
  await page.getByRole('button', { name: 'Back to Task History' }).click()

  await page.evaluate(() => window.api.browser.newTab())
  const address = page.getByRole('textbox', { name: 'Browser address' })
  await address.waitFor()
  await address.fill('https://example.com/')
  await address.press('Enter')
  await page.waitForFunction(() =>
    window.api.browser
      .getSessions()
      .then((state) =>
        state.sessions.some((session) => {
          let hostname = ''
          try {
            hostname = new URL(session.url).hostname
          } catch {
            return false
          }
          return hostname === 'example.com' && session.title.includes('Example Domain') && !session.isLoading
        })
      )
  )
  await shot(page, '05-live-browser-example')
  nativeShot('05b-live-browser-native-window')

  const taskPanelBeforeAway = await page.getByTestId('task-side-panel').count()
  await page.getByRole('button', { name: 'Models', exact: true }).click()
  await page.getByTestId('task-side-panel').waitFor({ state: 'detached' })
  await page.getByRole('heading', { name: 'Models', exact: true }).waitFor()
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
  const browserRegionWhileAway = await page.getByTestId('watched-web-region').count()
  await shot(page, '06-models-task-hidden')
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await page.getByTestId('task-side-panel').waitFor()
  await page.getByRole('heading', { name: 'Start a conversation', exact: true }).waitFor()
  await page.getByText('Browse the web for you', { exact: true }).waitFor()
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
  console.log(`ROUTE taskBefore=${taskPanelBeforeAway} regionWhileAway=${browserRegionWhileAway}`)
  await shot(page, '07-chat-task-restored')

  nativeShot('07b-chat-task-restored-native-window')

  const resize = page.getByRole('separator', { name: 'Resize Chat and task' })
  const main = page.getByTestId('main-workspace')
  const before = await main.boundingBox()
  if (!before) throw new Error('Main workspace has no measurable bounds')
  await resize.focus()
  for (let index = 0; index < 8; index += 1) await resize.press('ArrowLeft')
  await page.waitForFunction((beforeWidth) => {
    const workspace = document.querySelector('[data-testid="main-workspace"]')
    return workspace && Math.abs(workspace.getBoundingClientRect().width - beforeWidth) > 20
  }, before.width)
  const after = await main.boundingBox()
  console.log(`RESIZE before=${before?.width ?? 0} after=${after?.width ?? 0}`)
  if (!after || Math.abs(before.width - after.width) <= 20) {
    throw new Error('Keyboard resize did not change the dock width')
  }
  await shot(page, '08-task-keyboard-resized')
  await page.getByRole('button', { name: 'Hide main workspace' }).click()
  await page.getByRole('button', { name: 'Show main workspace' }).waitFor()
  await shot(page, '08-task-full-width')
  await page.getByRole('button', { name: 'Show main workspace' }).click()
  await resize.focus()
  for (let index = 0; index < 2; index += 1) await resize.press('ArrowRight')
  await page.waitForFunction(() => {
    const workspace = document.querySelector('[data-testid="main-workspace"]')
    return workspace && workspace.getBoundingClientRect().width > 600
  })

  const settings = page.getByRole('button', { name: 'Computer Use settings' })
  await settings.focus()
  await settings.press('Enter')
  await page.getByRole('button', { name: 'Computer Use task context' }).waitFor()
  await shot(page, '09-task-settings')
  await settings.focus()
  await settings.press('Enter')

  await page.getByRole('button', { name: 'Theme: Dark' }).click()
  await page.getByRole('button', { name: 'Theme: System' }).click()
  await page.getByRole('button', { name: 'Theme: Light' }).waitFor()
  await shot(page, '10-chat-tasks-docked-light')
  console.log(`EVIDENCE ${JSON.stringify(evidence)}`)
} finally {
  await app?.close().catch(() => {})
  await new Promise((resolve) => localPage.close(resolve))
  removeEvidenceProfile(profile)
}
