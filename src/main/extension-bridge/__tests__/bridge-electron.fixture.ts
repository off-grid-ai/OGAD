// A real Electron main process, real SQLite profile, HTTP, WebSockets and encryption.
// The seeded pairing represents a browser paired before this app restart.
import { app } from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSessionKey,
  seal,
  open,
  requestAad,
  responseAad
} from '../bridge-protocol'
import { helloAad, readyAad, newNonce, parseReady } from '../bridge-socket-protocol'

const timer = setTimeout(() => app.exit(1), 45_000)
app
  .whenReady()
  .then(async () => {
    const desktop = await generateKeyPair(true)
    const browser = await generateKeyPair(true)
    const device = 'native-browser-001'
    const profile = app.getPath('userData')
    await fs.mkdir(profile, { recursive: true })
    await fs.writeFile(
      path.join(profile, 'extension-bridge.json'),
      JSON.stringify({
        version: 1,
        key: {
          enc: 'none',
          data: JSON.stringify(await crypto.subtle.exportKey('jwk', desktop.privateKey))
        },
        browsers: [
          {
            id: device,
            name: 'Synthetic browser',
            publicKey: await exportPublicKey(browser.publicKey),
            pairedAt: Date.now()
          }
        ]
      })
    )
    const { handleExtensionBridge, handleExtensionUpgrade } = await import('../bridge-http')
    const { getBrowserLinks, listBridgeBrowsers, addBrowserLink } =
      await import('../bridge-electron')
    const server = http.createServer((req, res) => {
      void handleExtensionBridge(
        req,
        res,
        new URL(req.url!, 'http://localhost').pathname,
        req.method!
      )
    })
    server.on('upgrade', (req, socket, head) => {
      if (!handleExtensionUpgrade(req, socket, head)) socket.destroy()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const base = `http://127.0.0.1:${port}`
    const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
    const info = (await (
      await fetch(base + '/v1/extension/info', { headers: { origin } })
    ).json()) as { publicKey: string }
    const key = await deriveSessionKey(
      browser.privateKey,
      (await importPublicKey(info.publicKey))!,
      device
    )
    const call = async (
      method: string,
      params: Record<string, unknown> = {}
    ): Promise<{ status: number; body: { result?: unknown; error?: string } }> => {
      const id = randomUUID()
      const sealed = await seal(key, requestAad(device), { id, ts: Date.now(), method, params })
      const response = await fetch(base + '/v1/extension/rpc', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ v: 1, d: device, ...sealed })
      })
      const body = await response.json()
      if (response.status !== 200) return { status: response.status, body }
      return {
        status: response.status,
        body: (await open(key, responseAad(device, id), body)) as {
          result?: unknown
          error?: string
        }
      }
    }
    assert.equal(
      (await fetch(base + '/v1/extension/info', { headers: { origin: 'https://web.test' } }))
        .status,
      403
    )
    assert.equal(
      (await fetch(base + '/v1/extension/pair', { method: 'POST', body: '{}' })).status,
      403
    )
    assert.equal(
      (await fetch(base + '/v1/extension/pair', { method: 'POST', headers: { origin }, body: '{' }))
        .status,
      400
    )
    assert.equal((await fetch(base + '/v1/extension/other', { headers: { origin } })).status, 404)
    assert.equal((await call('state')).status, 200)
    for (const section of ['remote', 'tasks', 'tools', 'connectors', 'voice', 'image']) {
      const reply = await call('settings.get', { section })
      assert.equal(reply.status, 200)
      assert.ok(!reply.body.error, `${section}: ${JSON.stringify(reply.body)}`)
    }
    assert.equal(
      (await call('settings.set', { section: 'voice', patch: { ttsEnabled: true } })).status,
      200
    )
    const conversation = {
      id: 'native-chat',
      title: 'Synthetic chat',
      turns: [{ role: 'user', content: 'Hello' }]
    }
    const put = await call('conversations.put', { conversation })
    assert.ok(!put.body.error, JSON.stringify(put))
    await call('conversations.put', { conversation })
    const listed = await call('conversations.list')
    assert.ok(JSON.stringify(listed.body).includes('Hello'))
    assert.ok(!(await call('conversations.delete', { id: conversation.id })).body.error)
    assert.ok(!(await call('tools.list')).body.error)
    assert.ok((await call('settings.get', { section: 'invalid' })).body.error)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/extension/socket?d=${device}`, { origin })
    await once(ws, 'open')
    const readyMessage = once(ws, 'message')
    const nonce = newNonce()
    ws.send(JSON.stringify(await seal(key, helloAad(device), { nonce, ts: Date.now() })))
    const [raw] = await readyMessage
    assert.ok(parseReady(await open(key, readyAad(device, nonce), JSON.parse(String(raw)))))
    assert.equal(listBridgeBrowsers()[0]?.connected, true)
    const link = getBrowserLinks()[0]!
    const disconnected = once(ws, 'close')
    assert.ok(!(await call('unpair')).body.error)
    await disconnected
    assert.deepEqual(listBridgeBrowsers(), [])
    assert.deepEqual(getBrowserLinks(), [])
    await assert.rejects(link.request('tabs.list'), /disconnected/)
    // A handshake that finishes after unpair must not restore eligibility for tasks.
    addBrowserLink(link)
    assert.deepEqual(getBrowserLinks(), [])
    assert.equal((await call('state')).status, 401)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    console.log('EXTENSION_BRIDGE_NATIVE_PASSED')
    clearTimeout(timer)
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    clearTimeout(timer)
    app.exit(1)
  })
