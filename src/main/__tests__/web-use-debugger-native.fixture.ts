// Real Electron page, CDP, Playwright MCP, task loop and model HTTP client. The external
// browser protocol simulates Chrome refusing debugger access after an extension frame opens.
import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BrowserLink } from '../extension-bridge/bridge-socket'
import type { SocketEvent } from '../extension-bridge/bridge-socket-protocol'
import { createExtensionBrowserHost } from '../browser/extension-browser-host'
import { setRemoteVisionServerSettings } from '../vision/remote-vision-server'
import { getDB } from '../database'

const BLOCKED = 'Cannot access a chrome-extension:// URL of different extension'
const FORM =
  '<label>Business Email<input aria-label="Business Email" id="email"></label><button onclick="document.querySelector(\'output\').textContent=\'Application ready\'">Continue</button><output></output>'

void app.whenReady().then(async () => {
  let window: BrowserWindow | undefined
  let blocked = false
  let blockAfterFill = true
  let fallbackSnapshots = 0
  let pageActions = 0
  const events = new Set<(event: SocketEvent) => void>()
  const server = createServer((req, res) => {
    if (req.url === '/form') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(FORM)
      return
    }
    if (req.method === 'GET') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ data: [{ id: 'synthetic/text' }] }))
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += String(chunk)
    })
    req.on('end', () => {
      void (async () => {
        const request = JSON.parse(body)
        const contentParts = request.messages.at(-1).content
        const prompt =
          typeof contentParts === 'string'
            ? contentParts
            : contentParts
                .filter((part: { type: string }) => part.type === 'text')
                .map((part: { text: string }) => part.text)
                .join('\n')
        const snapshot =
          prompt.split('<untrusted_page_snapshot>')[1]?.split('</untrusted_page_snapshot>')[0] ?? ''
        const complete = snapshot.includes('Application ready')
        const filled = snapshot.includes('synthetic@example.test')
        // The external browser loses debugger access after the email field was filled.
        if (blockAfterFill && filled && !blocked) {
          blocked = true
          window!.webContents.debugger.detach()
        }
        const ref = complete
          ? null
          : filled
            ? /button "Continue" \[ref=([^\]]+)\]/.exec(snapshot)?.[1]
            : /textbox "Business Email" \[ref=([^\]]+)\]/.exec(snapshot)?.[1]
        assert.ok(complete || ref, `Missing form control in synthetic model input: ${snapshot}`)
        const content = JSON.stringify({
          action: complete ? 'done' : filled ? 'click' : 'type',
          phase_id: null,
          element: complete ? null : filled ? 'Continue' : 'Business Email',
          ref: ref ?? null,
          text: !complete && !filled ? 'synthetic@example.test' : null,
          key: null,
          values: null,
          start_element: null,
          start_ref: null,
          end_element: null,
          end_ref: null,
          url: null,
          evidence_ref: null,
          evidence_text: complete ? 'Application ready' : null,
          reason: '',
          summary: complete ? 'Application ready' : filled ? 'Continue' : 'Fill email'
        })
        res
          .writeHead(200, { 'content-type': 'text/event-stream' })
          .end(
            `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
          )
      })().catch((error) => {
        res
          .writeHead(500, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: { message: String(error) } }))
      })
    })
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    setRemoteVisionServerSettings({
      provider: 'openrouter',
      name: 'Synthetic',
      model: 'synthetic/text',
      endpoint,
      apiKey: 'synthetic'
    })
    window = new BrowserWindow({ show: false })
    const contents = window.webContents
    contents.debugger.on('message', (_event, method, params, sessionId) => {
      for (const listener of events)
        listener({
          event: 'cdp.event',
          tabId: 42,
          data: { method, params, ...(sessionId ? { sessionId } : {}) }
        })
    })
    contents.debugger.on('detach', (_event, reason) => {
      for (const listener of events)
        listener({ event: 'cdp.detached', tabId: 42, data: { reason } })
    })
    const link: BrowserLink = {
      browser: { id: 'synthetic', name: 'Synthetic Chromium', publicKey: 'synthetic', pairedAt: 1 },
      async request(op, args = {}) {
        if (op === 'browser.caps') return { cdp: true }
        if (op === 'tab.adopt') return { tabId: 42, url: `${endpoint}/form`, title: 'Form' }
        if (op === 'cdp.attach') {
          if (blocked) throw new Error(BLOCKED)
          if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
          return {}
        }
        if (op === 'cdp.detach') {
          contents.debugger.detach()
          return {}
        }
        if (op === 'cdp.send')
          return contents.debugger.sendCommand(
            String(args.method),
            args.params,
            args.sessionId as string | undefined
          )
        if (op === 'page.call') {
          const input = args.args as Record<string, unknown>
          if (args.tool === 'browser_snapshot') {
            fallbackSnapshots += 1
            const page = await contents.executeJavaScript(
              '({email: document.querySelector("input").value, result: document.querySelector("output").textContent})'
            )
            return {
              isError: false,
              text: `- textbox "Business Email" [ref=fresh-email]: ${page.email}\n- button "Continue" [ref=fresh-continue]\n- status: ${page.result}`
            }
          }
          if (args.tool === 'browser_type') {
            assert.equal(input.target, 'fresh-email')
            await contents.executeJavaScript(
              `document.querySelector('input').value=${JSON.stringify(input.text)}`
            )
          } else if (args.tool === 'browser_click') {
            assert.equal(input.target, 'fresh-continue')
            await contents.executeJavaScript("document.querySelector('button').click()")
          } else throw new Error(`Unexpected page tool ${args.tool}`)
          pageActions += 1
          return { isError: false, text: 'Action completed' }
        }
        throw new Error(`Unexpected browser operation ${op}`)
      },
      onEvent(listener) {
        events.add(listener)
        return () => {
          events.delete(listener)
        }
      },
      onClose: () => () => {},
      close: () => {}
    }
    for (const taskId of ['blocked-after-fill', 'blocked-at-start']) {
      await window.loadURL(`${endpoint}/form`)
      const result = await createExtensionBrowserHost(() => link, 42).runTask({
        goal: 'Fill Business Email with synthetic@example.test and click Continue',
        taskId,
        journeyId: taskId,
        checkpoint: {
          taskId,
          steps: [],
          plan: { version: 1, phases: [{ id: 'form', title: 'Fill form' }] }
        }
      })
      assert.equal(result.ok, true, result.summary)
      assert.equal(result.finalUrl, `${endpoint}/form`)
      assert.equal(
        await contents.executeJavaScript('document.querySelector("input").value'),
        'synthetic@example.test'
      )
      assert.equal(
        await contents.executeJavaScript('document.querySelector("output").textContent'),
        'Application ready'
      )
      assert.equal(pageActions, taskId === 'blocked-after-fill' ? 1 : 3)
      blockAfterFill = false
    }
    assert.ok(fallbackSnapshots >= 6)
    console.log('WEB_USE_DEBUGGER_NATIVE_PASSED')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    getDB().close()
    window?.destroy()
    app.exit(process.exitCode ? 1 : 0)
  }
})
