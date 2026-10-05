// The desktop end of the live channel to a paired browser (bridge-socket-protocol.ts).
// Pure apart from the socket it is handed, so the handshake and the command/reply plumbing
// are tested with a fake socket and the real protocol.
//
// A connected browser becomes a BrowserLink: request() sends one command and resolves with
// its reply; onEvent() hears what the browser reports on its own (CDP events, tab changes).

import { open, seal } from './bridge-protocol'
import {
  createChannel,
  helloAad,
  linkName,
  newNonce,
  parseHello,
  parseUpstream,
  readyAad,
  type SealedChannel,
  type SocketEvent,
  type SocketOp
} from './bridge-socket-protocol'
import type { PairedBrowser } from './bridge-service'

/** The slice of a WebSocket this needs. `ws` sockets satisfy it. */
export interface SocketLike {
  send(text: string): void
  close(code?: number, reason?: string): void
  on(event: 'message', listener: (data: unknown) => void): unknown
  on(event: 'close', listener: () => void): unknown
}

export interface BrowserLink {
  readonly browser: PairedBrowser
  request(op: SocketOp, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  onEvent(listener: (event: SocketEvent) => void): () => void
  onClose(listener: () => void): () => void
  close(): void
}

export interface AcceptDeps {
  linkKey(deviceId: string): Promise<{ browser: PairedBrowser; key: CryptoKey } | null>
  acceptNonce(deviceId: string, nonce: string): boolean
  now(): number
}

const HELLO_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 60_000

const text = (data: unknown): string =>
  typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data)

function firstMessage(socket: SocketLike, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    socket.on('message', (data) => {
      clearTimeout(timer)
      resolve(text(data))
    })
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(null)
    })
  })
}

function makeLink(
  socket: SocketLike,
  browser: PairedBrowser,
  channel: SealedChannel
): { link: BrowserLink; receive: (data: unknown) => void; closed: () => void } {
  let nextId = 1
  let isClosed = false
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const eventListeners = new Set<(event: SocketEvent) => void>()
  const closeListeners = new Set<() => void>()

  const closed = (): void => {
    if (isClosed) return
    isClosed = true
    for (const p of pending.values()) p.reject(new Error('The browser disconnected.'))
    pending.clear()
    for (const listener of closeListeners) listener()
  }
  const drop = (): void => {
    socket.close(1008, 'invalid frame')
    closed()
  }
  const receive = (data: unknown): void => {
    void channel.open(text(data)).then((raw) => {
      const message = raw === null ? null : parseUpstream(raw)
      if (!message) return drop()
      if ('event' in message) {
        for (const listener of eventListeners) listener(message)
        return
      }
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      if (message.ok) waiter?.resolve(message.result)
      else waiter?.reject(new Error(message.error))
    })
  }

  const link: BrowserLink = {
    browser,
    request(op, args = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
      if (isClosed) return Promise.reject(new Error('The browser disconnected.'))
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`The browser did not answer ${op} in time.`))
        }, timeoutMs)
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer)
            resolve(v)
          },
          reject: (e) => {
            clearTimeout(timer)
            reject(e)
          }
        })
        void channel.seal({ id, op, args }).then((frame) => socket.send(frame), reject)
      })
    },
    onEvent(listener) {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    onClose(listener) {
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
    close() {
      socket.close(1000, 'closed')
      closed()
    }
  }
  return { link, receive, closed }
}

/**
 * Run the handshake on a freshly upgraded socket. Resolves with the live link, or null after
 * closing the socket: unknown device, bad or stale hello, repeated nonce, or silence.
 */
export async function acceptBrowserSocket(
  deps: AcceptDeps,
  socket: SocketLike,
  deviceId: string
): Promise<BrowserLink | null> {
  // Listen before key derivation yields: the browser sends hello immediately.
  const helloMessage = firstMessage(socket, HELLO_TIMEOUT_MS)
  const known = await deps.linkKey(deviceId)
  const helloText = await helloMessage
  let hello: ReturnType<typeof parseHello> = null
  if (known && helloText) {
    try {
      const sealed = JSON.parse(helloText) as { n: string; c: string }
      hello = parseHello(await open(known.key, helloAad(deviceId), sealed), deps.now())
    } catch {
      hello = null
    }
  }
  if (!known || !hello || !deps.acceptNonce(deviceId, hello.nonce)) {
    socket.close(1008, 'unauthorized')
    return null
  }
  const desktopNonce = newNonce()
  socket.send(
    JSON.stringify(await seal(known.key, readyAad(deviceId, hello.nonce), { nonce: desktopNonce }))
  )
  const channel = createChannel({
    key: known.key,
    deviceId,
    link: linkName(hello.nonce, desktopNonce),
    role: 'desktop'
  })
  const { link, receive, closed } = makeLink(socket, known.browser, channel)
  socket.on('message', receive)
  socket.on('close', closed)
  return link
}

/** The browsers connected right now, newest first. */
export function createLinkRegistry(): {
  add(link: BrowserLink): void
  list(): BrowserLink[]
} {
  const links: BrowserLink[] = []
  return {
    add(link) {
      // One live link per browser: a reconnect replaces the old one.
      for (const old of links.filter((l) => l.browser.id === link.browser.id)) old.close()
      links.unshift(link)
      link.onClose(() => {
        const i = links.indexOf(link)
        if (i >= 0) links.splice(i, 1)
      })
    },
    list: () => [...links]
  }
}
