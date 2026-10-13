// Real Electron IPC, real model client, synthetic profile; only the external model is a fake.
import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setupChatNextActionIpc } from '../chat-next-action'
import { setRemoteVisionServerSettings } from '../vision/remote-vision-server'
import { getDB } from '../database'

void app.whenReady().then(async () => {
  let window: BrowserWindow | undefined
  const requests: Record<string, unknown>[] = []
  const responses = ['Suggestion: "Compare the tradeoffs."', 'NONE', 'failure']
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ data: [{ id: 'synthetic/text', object: 'model' }] }))
      return
    }
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', (part) => {
      body += String(part)
    })
    req.on('end', () => {
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(body) as Record<string, unknown>
      } catch {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: { message: 'Invalid JSON' } }))
        return
      }
      requests.push(payload)
      const content = responses.shift() ?? 'NONE'
      if (content === 'failure') {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: { message: 'Synthetic model failure' } }))
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' }).end(
          `data: ${JSON.stringify({
            choices: [{ delta: { content }, finish_reason: 'stop' }]
          })}\n\ndata: [DONE]\n\n`
        )
      }
    })
  })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    setRemoteVisionServerSettings({
      provider: 'openrouter',
      name: 'Synthetic text model',
      model: 'synthetic/text',
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      apiKey: 'synthetic-key'
    })
    setupChatNextActionIpc()
    window = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false }
    })
    await window.loadURL('data:text/html,<title>Synthetic suggestion test</title>')
    const suggest = (asked: unknown, answer: unknown): Promise<unknown> =>
      window!.webContents.executeJavaScript(
        `require('electron').ipcRenderer.invoke('chat:suggest-next', ${JSON.stringify(asked)}, ${JSON.stringify(answer)})`
      )
    assert.equal(await suggest(null, 'Answer'), null)
    assert.equal(requests.length, 0)
    assert.equal(await suggest('Compare these plans', 'Plan A is faster'), 'Compare the tradeoffs')
    const sent = requests[0]!
    assert.equal(sent.max_tokens, 40)
    assert.equal(sent.tools, undefined)
    const messages = sent.messages as { role: string; content: string }[]
    assert.ok(messages[0]!.content.includes('in this conversation'))
    assert.ok(messages[1]!.content.includes('Plan A is faster'))
    assert.equal(await suggest('Thank you', 'You are welcome'), null)
    assert.equal(await suggest('Compare these plans', 'Plan A is faster'), null)
    console.log('CHAT_NEXT_ACTION_NATIVE_PASSED')
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
