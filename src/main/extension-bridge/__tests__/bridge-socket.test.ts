import { describe, expect, it } from 'vitest'
import { deriveSessionKey, generateKeyPair, open, seal } from '../bridge-protocol'
import {
  createChannel,
  helloAad,
  linkName,
  newNonce,
  parseReady,
  readyAad,
  type SealedChannel
} from '../bridge-socket-protocol'
import {
  acceptBrowserSocket,
  createLinkRegistry,
  type AcceptDeps,
  type BrowserLink,
  type SocketLike
} from '../bridge-socket'

// The desktop's socket end against a browser that speaks the real protocol over an
// in-memory socket pair. Only the socket transport is a stand-in.

class FakeSocket implements SocketLike {
  peer: FakeSocket | null = null
  closedWith: number | null = null
  private listeners: Record<string, Array<(data?: unknown) => void>> = { message: [], close: [] }
  send(text: string): void {
    const peer = this.peer
    if (peer && peer.closedWith === null) queueMicrotask(() => peer.emit('message', text))
  }
  close(code = 1000): void {
    if (this.closedWith !== null) return
    this.closedWith = code
    this.emit('close')
    this.peer?.close(code)
  }
  on(event: 'message' | 'close', listener: (data?: unknown) => void): this {
    this.listeners[event]!.push(listener)
    return this
  }
  emit(event: string, data?: unknown): void {
    for (const l of this.listeners[event] ?? []) l(data)
  }
}

const DEVICE = 'device000001'
const BROWSER = { id: DEVICE, name: 'Brave extension', publicKey: 'k', pairedAt: 1 }

interface World {
  key: CryptoKey
  deps: AcceptDeps
  desk: FakeSocket
  tab: FakeSocket
}

async function world(opts: { known?: boolean; keyReady?: Promise<void> } = {}): Promise<World> {
  const a = await generateKeyPair()
  const b = await generateKeyPair(true)
  const key = await deriveSessionKey(a.privateKey, b.publicKey, DEVICE)
  const seen = new Set<string>()
  const deps: AcceptDeps = {
    linkKey: async (id) => {
      await opts.keyReady
      return opts.known === false || id !== DEVICE ? null : { browser: BROWSER, key }
    },
    acceptNonce: (id, nonce) => {
      const k = `${id}:${nonce}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    },
    now: () => Date.now()
  }
  const desk = new FakeSocket()
  const tab = new FakeSocket()
  desk.peer = tab
  tab.peer = desk
  return { key, deps, desk, tab }
}

/** The browser side: hello, read the answer, then a channel. */
async function browserHello(
  w: World,
  nonce = newNonce(),
  ts = Date.now()
): Promise<SealedChannel | null> {
  const answer = new Promise<string>((resolve) => w.tab.on('message', (d) => resolve(String(d))))
  w.tab.send(JSON.stringify(await seal(w.key, helloAad(DEVICE), { nonce, ts })))
  const ready = parseReady(await open(w.key, readyAad(DEVICE, nonce), JSON.parse(await answer)))
  return ready
    ? createChannel({
        key: w.key,
        deviceId: DEVICE,
        link: linkName(nonce, ready.nonce),
        role: 'browser'
      })
    : null
}

describe('acceptBrowserSocket', () => {
  it('links a paired browser: commands go down, replies and events come up', async () => {
    const w = await world()
    const accepted = acceptBrowserSocket(w.deps, w.desk, DEVICE)
    const channel = await browserHello(w)
    const link = await accepted
    expect(link?.browser.name).toBe('Brave extension')

    // The browser answers every command and reports one event.
    w.tab.on('message', (frame) => {
      void channel!.open(String(frame)).then(async (cmd) => {
        const c = cmd as { id: number; op: string }
        w.tab.send(
          await channel!.seal({ event: 'tab.updated', tabId: 7, data: { url: 'https://a.test/' } })
        )
        w.tab.send(await channel!.seal({ id: c.id, ok: true, result: [{ id: 7 }] }))
      })
    })
    const events: unknown[] = []
    link!.onEvent((e) => events.push(e))
    expect(await link!.request('tabs.list')).toEqual([{ id: 7 }])
    expect(events).toEqual([{ event: 'tab.updated', tabId: 7, data: { url: 'https://a.test/' } }])
  })

  it('accepts hello sent while the paired key is still loading', async () => {
    let releaseKey!: () => void
    const keyReady = new Promise<void>((resolve) => {
      releaseKey = resolve
    })
    const w = await world({ keyReady })
    const nonce = newNonce()
    const hello = JSON.stringify(await seal(w.key, helloAad(DEVICE), { nonce, ts: Date.now() }))
    const ready = new Promise<string>((resolve) =>
      w.tab.on('message', (data) => resolve(String(data)))
    )
    const accepted = acceptBrowserSocket(w.deps, w.desk, DEVICE)
    w.tab.send(hello)
    // Delivery is queued before this barrier; key lookup is still blocked.
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    releaseKey()
    expect(
      parseReady(await open(w.key, readyAad(DEVICE, nonce), JSON.parse(await ready)))
    ).not.toBeNull()
    const link = await accepted
    expect(link?.browser.name).toBe(BROWSER.name)
    link?.close()
  })

  it('passes on a browser error and rejects pending work when the browser goes', async () => {
    const w = await world()
    const accepted = acceptBrowserSocket(w.deps, w.desk, DEVICE)
    const channel = await browserHello(w)
    const link = (await accepted)!
    w.tab.on('message', (frame) => {
      void channel!.open(String(frame)).then(async (cmd) => {
        const c = cmd as { id: number; op: string }
        if (c.op === 'cdp.send') {
          w.tab.send(
            await channel!.seal({ id: c.id, ok: false, error: 'Cannot access a chrome:// URL' })
          )
        }
      })
    })
    await expect(link.request('cdp.send', { method: 'Page.navigate' })).rejects.toThrow(
      /chrome:\/\//
    )
    const waiting = link.request('tabs.list')
    w.tab.close()
    await expect(waiting).rejects.toThrow(/disconnected/)
  })

  it('refuses an unknown device, a replayed hello, and a stale one', async () => {
    const stranger = await world({ known: false })
    const refused = acceptBrowserSocket(stranger.deps, stranger.desk, DEVICE)
    stranger.tab.send(
      JSON.stringify(
        await seal(stranger.key, helloAad(DEVICE), { nonce: newNonce(), ts: Date.now() })
      )
    )
    expect(await refused).toBeNull()
    expect(stranger.desk.closedWith).toBe(1008)

    const w = await world()
    const nonce = newNonce()
    const first = acceptBrowserSocket(w.deps, w.desk, DEVICE)
    await browserHello(w, nonce)
    expect(await first).not.toBeNull()
    const again = await world()
    again.deps.acceptNonce = w.deps.acceptNonce
    const replayed = acceptBrowserSocket(again.deps, again.desk, DEVICE)
    again.tab.send(
      JSON.stringify(await seal(again.key, helloAad(DEVICE), { nonce, ts: Date.now() }))
    )
    expect(await replayed).toBeNull()

    const old = await world()
    const stale = acceptBrowserSocket(old.deps, old.desk, DEVICE)
    old.tab.send(
      JSON.stringify(
        await seal(old.key, helloAad(DEVICE), { nonce: newNonce(), ts: Date.now() - 600_000 })
      )
    )
    expect(await stale).toBeNull()
  })

  it('drops the link on a frame it cannot open', async () => {
    const w = await world()
    const accepted = acceptBrowserSocket(w.deps, w.desk, DEVICE)
    await browserHello(w)
    const link = (await accepted)!
    let closed = false
    link.onClose(() => (closed = true))
    w.tab.send('{"n":"AAAAAAAAAAAAAAAA","c":"AAAA"}')
    await new Promise((r) => setTimeout(r, 20))
    expect(closed).toBe(true)
    expect(w.desk.closedWith).toBe(1008)
  })
})

describe('createLinkRegistry', () => {
  it('keeps one live link per browser, newest first, and forgets closed ones', async () => {
    const registry = createLinkRegistry()
    const make = async (): Promise<BrowserLink> => {
      const w = await world()
      const accepted = acceptBrowserSocket(w.deps, w.desk, DEVICE)
      await browserHello(w)
      return (await accepted)!
    }
    const first = await make()
    registry.add(first)
    const second = await make()
    registry.add(second)
    expect(registry.list()).toEqual([second])
    second.close()
    expect(registry.list()).toEqual([])
  })
})
