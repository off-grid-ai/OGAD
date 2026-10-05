// HTTP for the extension bridge, mounted on the gateway at /v1/extension/*.
//
//   GET  /v1/extension/info   the desktop's public key (nothing private)
//   POST /v1/extension/pair   start pairing; answered after the user confirms in a native dialog
//   POST /v1/extension/rpc    every other call, sealed end to end
//
// Defence in layers, none of them the only one:
//   loopback only       the gateway binds to loopback; these routes check the peer again
//   no web pages        a request carrying an http(s) Origin is refused outright, and pairing
//                       requires an extension origin, so a site you visit cannot start one
//   sealed traffic      rpc bodies are AES-GCM under a key only a paired browser holds

import type http from 'http'
import type { Duplex } from 'stream'
import { WebSocketServer } from 'ws'
import { isExtensionOrigin } from './bridge-protocol'
import { addBrowserLink, getBridgeService } from './bridge-electron'
import type { BridgeReply } from './bridge-service'
import { acceptBrowserSocket } from './bridge-socket'
import { SOCKET_PATH } from './bridge-socket-protocol'

const MAX_BODY = 4 * 1024 * 1024

function isLoopback(req: http.IncomingMessage): boolean {
  const remote = req.socket.remoteAddress
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

function send(res: http.ServerResponse, origin: string | undefined, reply: BridgeReply): void {
  // The gateway answers every route with ACAO *. These routes answer only the extension.
  res.removeHeader('Access-Control-Allow-Origin')
  if (isExtensionOrigin(origin)) res.setHeader('Access-Control-Allow-Origin', origin as string)
  res.setHeader('Cache-Control', 'no-store')
  res.writeHead(reply.status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(reply.body))
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

export async function handleExtensionBridge(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  method: string
): Promise<void> {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
  if (!isLoopback(req) || (origin && /^https?:/i.test(origin))) {
    return send(res, origin, { status: 403, body: { error: 'forbidden' } })
  }
  try {
    const bridge = await getBridgeService()
    if (url === '/v1/extension/info' && method === 'GET') {
      return send(res, origin, await bridge.info())
    }
    if (url === '/v1/extension/pair' && method === 'POST') {
      if (!isExtensionOrigin(origin)) {
        return send(res, origin, { status: 403, body: { error: 'forbidden' } })
      }
      return send(res, origin, await bridge.pair(await readJson(req)))
    }
    if (url === '/v1/extension/rpc' && method === 'POST') {
      return send(res, origin, await bridge.rpc(await readJson(req)))
    }
    return send(res, origin, { status: 404, body: { error: 'not_found' } })
  } catch {
    // Never echo internals; the bridge's own errors are already generic.
    return send(res, origin, { status: 500, body: { error: 'bridge_error' } })
  }
}

const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/

/**
 * The live socket at /v1/extension/socket?d=<deviceId>. Same gates as pairing: loopback peer
 * and a browser-extension Origin. The sealed hello then proves the browser holds its key.
 * Returns false for any other upgrade so the gateway can decide what to do with it.
 */
export function handleExtensionUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer
): boolean {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname !== SOCKET_PATH) return false
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
  const deviceId = url.searchParams.get('d') ?? ''
  if (!isLoopback(req) || !isExtensionOrigin(origin) || !DEVICE_ID.test(deviceId)) {
    socket.destroy()
    return true
  }
  // Load the service before completing the upgrade, so hello cannot arrive
  // while the service starts and before its socket listener exists.
  void getBridgeService()
    .then((bridge) => {
      if (socket.destroyed) return
      sockets.handleUpgrade(req, socket, head, (ws) => {
        void acceptBrowserSocket(
          {
            linkKey: (id) => bridge.linkKey(id),
            acceptNonce: (id, nonce) => bridge.acceptNonce(id, nonce),
            now: Date.now
          },
          ws,
          deviceId
        )
          .then((link) => {
            if (link) addBrowserLink(link)
          })
          .catch(() => ws.close(1011, 'bridge_error'))
      })
    })
    .catch(() => socket.destroy())
  return true
}
