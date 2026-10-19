import { rpcHandlers, unpairBrowser } from './bridge-rpc-handlers'
import type { BridgeDeps, BridgeReply, PairedBrowser } from './bridge-types'
// The extension bridge, as pure logic: pairing and the sealed RPC loop. Everything it touches
// (key storage, the native confirm dialog, the chat database, tools, the vault) is injected,
// so this file is unit-tested without Electron. bridge-electron.ts supplies the real ones.
//
// Paired browsers are NOT sync devices. They live in their own store and never count toward
// the Pro device limit; a browser is a client of this desktop, not a peer in the mesh.

import {
  deriveSessionKey,
  exportPublicKey,
  importPublicKey,
  open,
  pairingCode,
  parseEnvelope,
  parsePairRequest,
  parseRpcRequest,
  ReplayGuard,
  requestAad,
  responseAad,
  seal,
  BRIDGE_VERSION
} from './bridge-protocol'

export type {
  BridgeData,
  BridgeDeps,
  BridgeReply,
  BridgeStore,
  BrowserTaskProgress,
  PairedBrowser
} from './bridge-types'

/** Browsers kept at most. Separate from, and never counted against, the sync device limit. */
export const MAX_BROWSERS = 10

export type { BridgeFeatures } from './bridge-protocol'

const UNAUTHORIZED: BridgeReply = { status: 401, body: { error: 'unauthorized' } }

export interface BridgeService {
  info(): Promise<BridgeReply>
  pair(raw: unknown, peerAddress?: string): Promise<BridgeReply>
  rpc(raw: unknown): Promise<BridgeReply>
  /** A paired browser and its session key, for the live socket. Null for an unknown device. */
  linkKey(deviceId: string): Promise<{ browser: PairedBrowser; key: CryptoKey } | null>
  /** True the first time a socket hello nonce is seen inside the freshness window. */
  acceptNonce(deviceId: string, nonce: string): boolean
  /** The person removed this browser on Desktop. False when it is not paired. */
  removeBrowser(deviceId: string): Promise<boolean>
}

export function createBridgeService(deps: BridgeDeps): BridgeService {
  const replay = new ReplayGuard()
  const sessionKeys = new Map<string, Promise<CryptoKey>>()
  let pairing = false
  const declinedPeers = new Map<string, number>()

  const sessionKey = (browser: PairedBrowser): Promise<CryptoKey> => {
    const cached = sessionKeys.get(browser.id)
    if (cached) {
      return cached
    }
    const derived = (async () => {
      const peer = await importPublicKey(browser.publicKey)
      if (!peer) {
        throw new Error('stored key invalid')
      }
      return deriveSessionKey(deps.keys.privateKey, peer, browser.id)
    })()
    sessionKeys.set(browser.id, derived)
    return derived
  }

  const forgetSession = (id: string): void => void sessionKeys.delete(id)
  const handlers = rpcHandlers(deps, forgetSession)

  return {
    /** Unauthenticated: the desktop's public key and protocol version. Nothing private. */
    async info(): Promise<BridgeReply> {
      return {
        status: 200,
        body: { v: BRIDGE_VERSION, publicKey: await exportPublicKey(deps.keys.publicKey) }
      }
    },

    async pair(raw: unknown, peerAddress = '127.0.0.1'): Promise<BridgeReply> {
      const request = parsePairRequest(raw)
      if (!request || !(await importPublicKey(request.publicKey))) {
        return { status: 400, body: { error: 'invalid' } }
      }
      // One prompt at a time: a page or process cannot stack dialogs on the user.
      if (pairing) {
        return { status: 409, body: { error: 'busy' } }
      }
      const address = peerAddress.replace(/^::ffff:/, '')
      for (const [peer, until] of declinedPeers) {
        if (until <= deps.now()) declinedPeers.delete(peer)
      }
      if (declinedPeers.has(address)) {
        return { status: 429, body: { error: 'rate_limited' } }
      }
      pairing = true
      try {
        const code = await pairingCode(
          request.publicKey,
          await exportPublicKey(deps.keys.publicKey)
        )
        if (!(await deps.confirmPairing(code, request.deviceName, address))) {
          declinedPeers.set(address, deps.now() + 30_000)
          return { status: 403, body: { error: 'declined' } }
        }
        const existing = (await deps.store.list()).filter((b) => b.publicKey !== request.publicKey)
        const browser: PairedBrowser = {
          id: deps.newId(),
          name: request.deviceName,
          publicKey: request.publicKey,
          pairedAt: deps.now()
        }
        await deps.store.save([browser, ...existing].slice(0, MAX_BROWSERS))
        return { status: 200, body: { deviceId: browser.id } }
      } finally {
        pairing = false
      }
    },

    async rpc(raw: unknown): Promise<BridgeReply> {
      const envelope = parseEnvelope(raw)
      if (!envelope) {
        return UNAUTHORIZED
      }
      const browser = (await deps.store.list()).find((b) => b.id === envelope.d)
      if (!browser) {
        return UNAUTHORIZED
      }
      const key = await sessionKey(browser)
      const request = parseRpcRequest(await open(key, requestAad(browser.id), envelope), deps.now())
      // Wrong key, tampered, stale or replayed all look the same from outside.
      if (!request || !replay.accept(`${browser.id}:${request.id}`, deps.now())) {
        return UNAUTHORIZED
      }
      let reply: unknown
      try {
        // Pairing, access status and cleanup remain available without Pro.
        if (
          !['state', 'unpair', 'tasks.stop', 'chat.stop'].includes(request.method) &&
          !deps.data.features().pro
        ) {
          throw new Error('pro_required')
        }
        const result = await handlers[request.method](request.params, browser)
        reply = { id: request.id, ok: true, result }
      } catch (error) {
        // Error text only: no stack, no argument echo.
        reply = {
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : 'failed'
        }
      }
      return { status: 200, body: await seal(key, responseAad(browser.id, request.id), reply) }
    },

    async linkKey(deviceId: string) {
      const browser = (await deps.store.list()).find((b) => b.id === deviceId)
      return browser && deps.data.features().pro
        ? { browser, key: await sessionKey(browser) }
        : null
    },

    acceptNonce(deviceId: string, nonce: string): boolean {
      return replay.accept(`${deviceId}:hello:${nonce}`, deps.now())
    },

    async removeBrowser(deviceId: string): Promise<boolean> {
      const browser = (await deps.store.list()).find((b) => b.id === deviceId)
      if (!browser) return false
      await unpairBrowser(deps, browser, forgetSession)
      return true
    }
  }
}
