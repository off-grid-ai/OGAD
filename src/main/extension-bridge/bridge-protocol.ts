// SHARED VERBATIM with off-grid-ai/browser-extension src/shared/bridge/protocol.ts. Change both.
// The private channel between the browser extension and Off Grid AI Desktop.
//
// THIS FILE IS SHARED VERBATIM with the desktop (src/main/extension-bridge/bridge-protocol.ts).
// Change both, or neither. It is pure WebCrypto (browser service worker and Electron's Node
// both have it), so neither side needs a crypto dependency.
//
// Same guarantees as mobile <-> desktop sync, over the only socket a browser extension can
// open (HTTP to loopback):
//
//   Pairing    ECDH P-256. Each side keeps a long-term key pair; public keys are exchanged once.
//              Both sides show the same six-word code derived from BOTH public keys, and the
//              user confirms it in the desktop's own window. A process that slipped its own
//              key into the exchange produces a different code.
//   Session    HKDF-SHA256 over the ECDH secret, bound to the device id, gives an AES-256-GCM
//              key. It is never sent; each side derives it.
//   Every call A single POST /v1/extension/rpc whose body is sealed: nothing about the call
//              (method, chat text, tool, vault entry) is readable on the wire, and holding the
//              key IS the authentication. Requests carry a timestamp and a unique id; stale or
//              repeated requests are refused, so a captured request cannot be replayed.
//
// Browsers paired this way are NOT sync devices: they live in their own store on the desktop
// and never count toward the device limit.

export const BRIDGE_VERSION = 1
const HKDF_SALT = 'offgrid-extension-bridge-v1'
/** How far a request's timestamp may be from the receiver's clock. */
export const MAX_SKEW_MS = 120_000

const enc = new TextEncoder()
const dec = new TextDecoder()

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) {
    s += String.fromCharCode(b)
  }
  return btoa(s)
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    return null
  }
  const bin = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i)
  }
  return out
}

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const

/**
 * A long-term key pair. The extension keeps its private key non-extractable (in IndexedDB it can
 * be used, never read). The desktop must persist its key across restarts, so it asks for an
 * extractable one and stores it encrypted at rest by the OS (Electron safeStorage).
 */
export function generateKeyPair(extractable = false): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ECDH, extractable, ['deriveBits']) as Promise<CryptoKeyPair>
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  return toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key)))
}

/** Import a peer's public key. Null for anything that is not an uncompressed P-256 point. */
export async function importPublicKey(b64: string): Promise<CryptoKey | null> {
  const raw = fromBase64(b64)
  if (!raw || raw.length !== 65 || raw[0] !== 4) {
    return null
  }
  try {
    return await crypto.subtle.importKey('raw', raw, ECDH, true, [])
  } catch {
    return null
  }
}

/** The session key both sides derive independently. Bound to the device id. */
export async function deriveSessionKey(
  ownPrivate: CryptoKey,
  peerPublic: CryptoKey,
  deviceId: string
): Promise<CryptoKey> {
  const secret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublic },
    ownPrivate,
    256
  )
  const hkdfKey = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(HKDF_SALT), info: enc.encode(deviceId) },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

// 256 short, distinct words: one byte each, six bytes of the transcript hash.
const WORDS = (
  'acid aged also area army away baby back bake ball band bank bark barn base bath beam bean bear beat ' +
  'bell belt bend best bike bird bite blue boat body bold bone book boot born bowl buck bulb bush busy ' +
  'cake calm camp cane card care cart case cash cast cave cell chef chip city clay clip club coal coat ' +
  'code coil coin cold cone cook cool cord corn cost crab crew crop crow cube cure dark dart dash dawn ' +
  'deck deep deer desk dial dice dine dish dock dome door dove down drum duck dune dusk dust each earn ' +
  'east echo edge epic even exit face fact fair fall farm fast fern film fire fish five flag flat flow ' +
  'foam fold food foot fork form fort four frog fuel full game gate gear gift glow goat gold golf good ' +
  'gown grid grin grow gulf hail hair half hall hand harp hawk heat herb hill hint hive hold home hood ' +
  'hook horn huge hunt iced idea inch iron item jade jazz join joke jump keen kelp kept kick kind king ' +
  'kite knee knot lace lake lamp land lane last lava lawn leaf left lens life lime line lion list load ' +
  'loaf lock loft logo long loop lord lush mail main mall mane maps mask mast meal mild milk mill mint ' +
  'mist moat mode mole moon moss moth mule nail navy neat nest news next nice node noon nose note oars ' +
  'oath oven pace pack page palm park path peak pear pine pink pipe plan plum poem pond pony pool port ' +
  'pull pure quay quiz race raft rail rain ramp reef rice ring road'
).split(' ')

/**
 * The code both sides show during pairing. Order-independent: sorted keys, so the desktop and the
 * extension compute the same words without agreeing on who is "first".
 */
export async function pairingCode(publicA: string, publicB: string): Promise<string> {
  // Keys are wire data: keep code-unit ordering, independent of the OS locale.
  const [x, y] = [publicA, publicB].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${x}|${y}`)))
  return Array.from(digest.slice(0, 6), (b) => WORDS[b] as string).join('-')
}

export interface Sealed {
  readonly n: string
  readonly c: string
}

/** Encrypt a JSON value. `aad` binds it to who sent it and why (device + direction + id). */
export async function seal(key: CryptoKey, aad: string, value: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    key,
    enc.encode(JSON.stringify(value))
  )
  return { n: toBase64(iv), c: toBase64(new Uint8Array(ct)) }
}

/** Decrypt and parse. Null for a wrong key, tampered bytes, the wrong aad, or bad JSON. */
export async function open(key: CryptoKey, aad: string, sealed: Sealed): Promise<unknown> {
  const iv = fromBase64(sealed.n)
  const ct = fromBase64(sealed.c)
  if (!iv || iv.length !== 12 || !ct) {
    return null
  }
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
      key,
      ct
    )
    return JSON.parse(dec.decode(pt)) as unknown
  } catch {
    return null
  }
}

export const requestAad = (deviceId: string): string => `${deviceId}|request`
export const responseAad = (deviceId: string, id: string): string => `${deviceId}|response|${id}`

// ---- Wire shapes -------------------------------------------------------------------------------

/** The plaintext envelope POSTed to /v1/extension/rpc. Only `d` is readable. */
export interface RpcEnvelope extends Sealed {
  readonly v: typeof BRIDGE_VERSION
  /** The device id, so the desktop knows which key to try. Not a secret. */
  readonly d: string
}

export const RPC_METHODS = [
  'state',
  'conversations.list',
  'conversations.put',
  'conversations.delete',
  'tools.list',
  'tools.run',
  'tasks.latest',
  'tasks.stop',
  'vault',
  'settings.get',
  'settings.set',
  'unpair'
] as const
export type RpcMethod = (typeof RPC_METHODS)[number]

/** What is inside a sealed request. */
export interface RpcRequest {
  readonly id: string
  readonly ts: number
  readonly method: RpcMethod
  readonly params: Record<string, unknown>
}

export type RpcResponse =
  | { readonly id: string; readonly ok: true; readonly result: unknown }
  | { readonly id: string; readonly ok: false; readonly error: string }

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const ID = /^[A-Za-z0-9_-]{8,64}$/

export function parseEnvelope(raw: unknown): RpcEnvelope | null {
  if (!isObj(raw) || raw.v !== BRIDGE_VERSION) {
    return null
  }
  if (
    typeof raw.d !== 'string' ||
    !ID.test(raw.d) ||
    typeof raw.n !== 'string' ||
    typeof raw.c !== 'string'
  ) {
    return null
  }
  return { v: BRIDGE_VERSION, d: raw.d, n: raw.n, c: raw.c }
}

export function parseRpcRequest(raw: unknown, now: number): RpcRequest | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !ID.test(raw.id)) {
    return null
  }
  if (typeof raw.ts !== 'number' || Math.abs(now - raw.ts) > MAX_SKEW_MS) {
    return null
  }
  if (typeof raw.method !== 'string' || !(RPC_METHODS as readonly string[]).includes(raw.method)) {
    return null
  }
  const params = raw.params === undefined ? {} : raw.params
  if (!isObj(params)) {
    return null
  }
  return { id: raw.id, ts: raw.ts, method: raw.method as RpcMethod, params }
}

export function parseRpcResponse(raw: unknown, expectedId: string): RpcResponse | null {
  if (!isObj(raw) || raw.id !== expectedId) {
    return null
  }
  if (raw.ok === true) {
    return { id: expectedId, ok: true, result: raw.result }
  }
  return raw.ok === false && typeof raw.error === 'string'
    ? { id: expectedId, ok: false, error: raw.error }
    : null
}

/**
 * Remembers request ids inside the freshness window so a captured request cannot be replayed.
 * Ids older than the window are forgotten; requests that old are refused on their timestamp.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>()

  /** True the first time an id is seen, false for a repeat. */
  accept(id: string, now: number): boolean {
    for (const [key, at] of this.seen) {
      if (now - at > MAX_SKEW_MS * 2) {
        this.seen.delete(key)
      }
    }
    if (this.seen.has(id)) {
      return false
    }
    this.seen.set(id, now)
    return true
  }
}

/** Pairing request (plaintext: only public keys and a display name). */
export interface PairRequest {
  readonly v: typeof BRIDGE_VERSION
  readonly publicKey: string
  readonly deviceName: string
}

export function parsePairRequest(raw: unknown): PairRequest | null {
  if (!isObj(raw) || raw.v !== BRIDGE_VERSION || typeof raw.publicKey !== 'string') {
    return null
  }
  if (typeof raw.deviceName !== 'string') {
    return null
  }
  const deviceName = raw.deviceName
    .replace(/[^\p{L}\p{N} ._()-]/gu, '')
    .trim()
    .slice(0, 48)
  return deviceName ? { v: BRIDGE_VERSION, publicKey: raw.publicKey, deviceName } : null
}

/** Origins allowed to pair: browser extensions only. A web page's Origin is http(s). */
export function isExtensionOrigin(origin: string | undefined): boolean {
  return (
    typeof origin === 'string' &&
    /^(chrome-extension|moz-extension):\/\/[a-z0-9-]{8,64}\/?$/i.test(origin)
  )
}
