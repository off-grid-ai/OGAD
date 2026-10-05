// SHARED VERBATIM with off-grid-ai/browser-extension src/shared/bridge/socket.ts. Change both.
// The live channel between a paired browser and Off Grid AI Desktop, for work that needs a
// stream rather than request/response: the desktop driving a tab (web_use in the default
// browser) sends many commands and receives many events.
//
// THIS FILE IS SHARED VERBATIM with the desktop (src/main/extension-bridge/bridge-socket-protocol.ts).
// Change both, or neither. Same keys and guarantees as the sealed RPC (protocol.ts):
//
//   Hello      The browser opens ws://127.0.0.1:7878/v1/extension/socket?d=<deviceId> and sends
//              a sealed hello carrying a fresh nonce and its clock. The desktop refuses a stale
//              or repeated hello, then answers with its own nonce, sealed and bound to the
//              browser's. Both nonces name this one link.
//   Frames     Every frame after that is sealed with AAD = device | link | direction | sequence.
//              A frame from another link, the other direction, out of order, or repeated fails
//              to open, and the receiver drops the socket. Nothing on the wire is readable.

import { MAX_SKEW_MS, fromBase64, open, seal, toBase64, type Sealed } from './bridge-protocol'

export const SOCKET_PATH = '/v1/extension/socket'

export type SocketRole = 'browser' | 'desktop'
type Direction = 'up' | 'down'

const NONCE = /^[A-Za-z0-9+/]{22}==$/

export const helloAad = (deviceId: string): string => `${deviceId}|socket-hello`
export const readyAad = (deviceId: string, browserNonce: string): string =>
  `${deviceId}|socket-ready|${browserNonce}`
const frameAad = (link: { deviceId: string; link: string }, dir: Direction, seq: number): string =>
  `${link.deviceId}|socket|${link.link}|${dir}|${seq}`

export function newNonce(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(16)))
}

export interface Hello {
  readonly nonce: string
  readonly ts: number
}

/** The desktop's check of a hello it opened. Null for stale or malformed. */
export function parseHello(raw: unknown, now: number): Hello | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const h = raw as Record<string, unknown>
  if (typeof h.nonce !== 'string' || !NONCE.test(h.nonce) || !fromBase64(h.nonce)) {
    return null
  }
  if (typeof h.ts !== 'number' || Math.abs(now - h.ts) > MAX_SKEW_MS) {
    return null
  }
  return { nonce: h.nonce, ts: h.ts }
}

/** The browser's check of the desktop's answer. Null for malformed. */
export function parseReady(raw: unknown): { nonce: string } | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const nonce = (raw as Record<string, unknown>).nonce
  return typeof nonce === 'string' && NONCE.test(nonce) ? { nonce } : null
}

export const linkName = (browserNonce: string, desktopNonce: string): string =>
  `${browserNonce}.${desktopNonce}`

function parseFrame(text: string): Sealed | null {
  try {
    const f = JSON.parse(text) as Record<string, unknown>
    return typeof f.n === 'string' && typeof f.c === 'string' ? { n: f.n, c: f.c } : null
  } catch {
    return null
  }
}

export interface SealedChannel {
  /** Seal one message for the wire. Sequence numbers are taken in call order. */
  seal(message: unknown): Promise<string>
  /** Open one frame. Null means the frame is not the next one from the peer: drop the link. */
  open(frame: string): Promise<unknown>
}

export function createChannel(opts: {
  key: CryptoKey
  deviceId: string
  link: string
  role: SocketRole
}): SealedChannel {
  const send: Direction = opts.role === 'browser' ? 'up' : 'down'
  const receive: Direction = opts.role === 'browser' ? 'down' : 'up'
  let sent = 0
  let received = 0
  let broken = false
  return {
    async seal(message) {
      const aad = frameAad(opts, send, sent++)
      return JSON.stringify(await seal(opts.key, aad, message))
    },
    async open(frame) {
      // The expected number is taken now, in arrival order, before any await.
      const seq = received++
      const sealed = broken ? null : parseFrame(frame)
      const value = sealed ? await open(opts.key, frameAad(opts, receive, seq), sealed) : null
      if (value === null) {
        broken = true
      }
      return value
    }
  }
}

/**
 * Commands the desktop sends down. Each gets exactly one reply with the same id.
 *
 * Two ways to drive a tab. `cdp.*` is the browser's debugger protocol, where it has one
 * (Chromium). `page.call` runs one Playwright MCP tool (browser_snapshot, browser_click, ...)
 * against the tab from the extension itself, for browsers without one (Firefox).
 * `browser.caps` says which this browser offers.
 */
export const SOCKET_OPS = [
  'browser.caps',
  'tabs.list',
  'tab.create',
  /** Take the tab the browser offered for this task (tools.run tabId), instead of a new one. */
  'tab.adopt',
  'tab.close',
  'cdp.attach',
  'cdp.detach',
  'cdp.send',
  'page.call'
] as const
export type SocketOp = (typeof SOCKET_OPS)[number]

export interface SocketCommand {
  readonly id: number
  readonly op: SocketOp
  readonly args: Record<string, unknown>
}

/** The reply to `browser.caps`. */
export interface BrowserCaps {
  /** The tab can be driven over `cdp.*`. False means `page.call` only. */
  readonly cdp: boolean
}

/** The Playwright MCP tools `page.call` runs, and its reply. */
export const PAGE_TOOLS = [
  'browser_snapshot',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_select_option',
  'browser_press_key',
  'browser_hover',
  'browser_drag',
  'browser_tabs'
] as const
export type PageTool = (typeof PAGE_TOOLS)[number]

export interface PageToolResult {
  readonly text: string
  readonly isError: boolean
}

export type SocketReply =
  | { readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string }

/** Events the browser sends up unprompted. `ping` keeps an idle link (and the extension's
 *  worker) alive; it carries nothing. */
export interface SocketEvent {
  readonly event: 'cdp.event' | 'cdp.detached' | 'tab.removed' | 'tab.updated' | 'ping'
  readonly tabId: number
  readonly data: Record<string, unknown>
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseCommand(raw: unknown): SocketCommand | null {
  if (!isObj(raw) || !Number.isSafeInteger(raw.id) || !isObj(raw.args)) {
    return null
  }
  return (SOCKET_OPS as readonly unknown[]).includes(raw.op)
    ? { id: raw.id as number, op: raw.op as SocketOp, args: raw.args }
    : null
}

/** A browser message: a reply to a command, or an event. */
export function parseUpstream(raw: unknown): SocketReply | SocketEvent | null {
  if (!isObj(raw)) {
    return null
  }
  if (Number.isSafeInteger(raw.id)) {
    if (raw.ok === true) {
      return { id: raw.id as number, ok: true, result: raw.result }
    }
    return raw.ok === false && typeof raw.error === 'string'
      ? { id: raw.id as number, ok: false, error: raw.error }
      : null
  }
  const events = ['cdp.event', 'cdp.detached', 'tab.removed', 'tab.updated', 'ping']
  return events.includes(raw.event as string) && Number.isSafeInteger(raw.tabId) && isObj(raw.data)
    ? { event: raw.event as SocketEvent['event'], tabId: raw.tabId as number, data: raw.data }
    : null
}
