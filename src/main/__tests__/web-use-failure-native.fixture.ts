// Real task host, model client, page session and task history. Only the external browser
// extension and HTTP model provider use contract-faithful synthetic boundaries.
import { app, BrowserWindow } from 'electron'
import { registerBrowserViewIpc, disposeBrowserHost } from '../browser/browser-host'
import { controlVisionTask } from '../vision/vision-controller'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BrowserLink } from '../extension-bridge/bridge-socket'
import { createExtensionBrowserHost } from '../browser/extension-browser-host'
import type { WebTaskResult } from '../browser/browser-rail'
import { setRemoteVisionServerSettings } from '../vision/remote-vision-server'
import { getTaskRun } from '../tasks/task-history'
import { getDB } from '../database'

function decision(action: string, ref: string | null): Record<string, unknown> {
  return {
    action,
    phase_id: null,
    element: ref ? 'Place order' : null,
    ref,
    text: null,
    key: null,
    values: null,
    start_element: null,
    start_ref: null,
    end_element: null,
    end_ref: null,
    url: null,
    evidence_ref: null,
    evidence_text: null,
    reason: '',
    summary: `${action} ${ref ?? ''}`.trim()
  }
}
const done = { ...decision('done', null), phase_id: 'read', evidence_text: 'Order placed' }

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(check(), 'Timed out waiting for the synthetic browser')
}

void app.whenReady().then(async () => {
  let window: BrowserWindow | undefined
  let holdModel = false
  let modelStarted!: () => void
  const pendingModel = new Promise<void>((resolve) => {
    modelStarted = resolve
  })
  let modelRequests = 0
  let modelFails = true
  // Queued decisions for the uncertain-action runs; empty means the visual fallback reply.
  const replies: Array<Record<string, unknown>> = []
  // What the synthetic extension answers for an input action, and the inputs it received.
  let actionResult: Record<string, unknown> | null = null
  const actions: string[] = []
  const server = createServer((req, res) => {
    req.resume()
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'synthetic/text', object: 'model' }] }))
      return
    }
    if (holdModel) {
      modelStarted()
      return
    }
    modelRequests += 1
    if (modelFails) {
      res.writeHead(402, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Insufficient credits' } }))
      return
    }
    const content = JSON.stringify(
      replies.shift() ?? {
        action: 'fallback',
        phase_id: null,
        element: null,
        ref: null,
        text: null,
        key: null,
        values: null,
        start_element: null,
        start_ref: null,
        end_element: null,
        end_ref: null,
        url: null,
        evidence_ref: null,
        evidence_text: null,
        reason: 'The notification content is drawn on a canvas with no readable controls.',
        summary: ''
      }
    )
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
    )
  })
  const link: BrowserLink = {
    browser: {
      id: 'synthetic-browser',
      name: 'Synthetic browser',
      publicKey: 'synthetic',
      pairedAt: 1
    },
    async request(op, args = {}) {
      if (op === 'browser.caps') return { cdp: false }
      if (op === 'tab.adopt')
        return { tabId: args.tabId, url: 'https://synthetic.test/', title: 'Synthetic page' }
      if (op === 'page.call' && actionResult && args.tool !== 'browser_snapshot') {
        actions.push(String(args.tool))
        return actionResult
      }
      if (op === 'page.call' && actionResult) {
        return { text: '- button "Place order" [ref=e1]\n- text "Order placed"', isError: false }
      }
      if (op === 'page.call') return { text: '- button "Notifications" [ref=e1]', isError: false }
      if (op === 'cdp.detach') return {}
      throw new Error(`Unexpected browser operation: ${op}`)
    },
    onEvent: () => () => {},
    onClose: () => () => {},
    close: () => {}
  }
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    setRemoteVisionServerSettings({
      provider: 'openrouter',
      name: 'Synthetic model',
      model: 'synthetic/text',
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      apiKey: 'synthetic-key'
    })
    const run = (taskId: string): Promise<WebTaskResult> =>
      createExtensionBrowserHost(() => link, 42).runTask({
        goal: 'Read unread notifications',
        taskId,
        journeyId: taskId,
        checkpoint: {
          taskId,
          steps: [],
          plan: { version: 1, phases: [{ id: 'read', title: 'Read notifications' }] }
        }
      })
    const failed = await run('model-unavailable')
    assert.equal(failed.ok, false)
    assert.match(failed.summary, /402/)
    assert.match(failed.summary, /Insufficient credits/)
    assert.doesNotMatch(failed.summary, /visual control|Switch Tasks/)
    assert.equal(getTaskRun('model-unavailable')?.summary, failed.summary)
    modelFails = false
    const visual = await run('visual-page')
    assert.equal(visual.ok, false)
    assert.match(visual.summary, /canvas with no readable controls/)
    assert.equal(modelRequests, 2)

    // An action the page did not confirm may have run: it is never sent again, also when the
    // next snapshot gives the same control a new reference, and also from an older extension.
    for (const result of [
      { text: 'The action may have run.', isError: false, uncertain: true },
      { text: 'The page did not answer.', isError: true }
    ]) {
      actionResult = result
      actions.length = 0
      replies.push(decision('click', 'e1'), decision('click', 'e2'), done)
      const uncertain = await run(`uncertain-${result.isError ? 'legacy' : 'flag'}`)
      assert.equal(uncertain.ok, true, uncertain.summary)
      assert.deepEqual(actions, ['browser_click'])
    }

    // Two unconfirmed inputs in a row: the task waits for the user before the next decision.
    actionResult = { text: 'The action may have run.', isError: false, uncertain: true }
    actions.length = 0
    replies.push(decision('click', 'e1'), { ...decision('press_key', null), key: 'Enter' }, done)
    const requestsBefore = modelRequests
    const paused = run('uncertain-twice')
    await until(() => actions.length === 2)
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(modelRequests, requestsBefore + 2, 'No decision while waiting for the user')
    assert.equal(controlVisionTask('resume', 'uncertain-twice'), true)
    assert.equal((await paused).ok, true)
    assert.deepEqual(actions, ['browser_click', 'browser_press_key'])
    actionResult = null
    holdModel = true
    const running = run('external-active')
    await pendingModel
    registerBrowserViewIpc()
    window = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false }
    })
    await window.loadURL('data:text/html,<title>Synthetic browser task</title>')
    assert.equal(
      await window.webContents.executeJavaScript(
        "require('electron').ipcRenderer.invoke('browser:reopen', 'external-active')"
      ),
      false
    )
    const sessions = await window.webContents.executeJavaScript(
      "require('electron').ipcRenderer.invoke('browser:get-sessions')"
    )
    assert.deepEqual(
      sessions.sessions,
      [],
      'Opening task details must not allocate a duplicate browser page'
    )
    controlVisionTask('stop', 'external-active')
    await running
    console.log('WEB_USE_FAILURE_NATIVE_PASSED')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    window?.destroy()
    disposeBrowserHost()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    getDB().close()
    app.exit(process.exitCode ? 1 : 0)
  }
})
