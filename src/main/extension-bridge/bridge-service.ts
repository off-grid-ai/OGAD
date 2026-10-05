// SHARED VERBATIM with off-grid-ai/browser-extension src/shared/bridge/service.ts. Change both.
// SHARED VERBATIM with off-grid-ai/desktop src/main/extension-bridge/bridge-service.ts. Change both.
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
  BRIDGE_VERSION,
  type RpcMethod
} from './bridge-protocol'
import { isSettingsSection, parseSettingsPatch, type SettingsSection } from './bridge-settings'
import type { BrowserTaskProgress } from './task-progress'

export interface PairedBrowser {
  readonly id: string
  readonly name: string
  readonly publicKey: string
  readonly pairedAt: number
}

/** Browsers kept at most. Separate from, and never counted against, the sync device limit. */
export const MAX_BROWSERS = 10

export interface BridgeStore {
  list(): Promise<readonly PairedBrowser[]>
  save(browsers: readonly PairedBrowser[]): Promise<void>
}

/** What this desktop offers right now, from its real entitlement and registered features. */
export interface BridgeFeatures {
  readonly pro: boolean
  readonly chats: boolean
  readonly tools: boolean
  readonly connectors: boolean
  readonly vault: boolean
  /** Tasks may drive this browser (web_use in the default browser), so keep the live socket open. */
  readonly browserTasks?: boolean
}

export interface BridgeData {
  features(): BridgeFeatures
  desktopName(): string
  listConversations(): Promise<unknown[]>
  putConversation(conversation: unknown, browser: PairedBrowser): Promise<void>
  deleteConversation(id: string): Promise<void>
  listTools(): Promise<unknown[]>
  /** `tabId`: the browser's tab a web task should start in (browser-start-tab.ts). */
  runTool(
    name: string,
    args: Record<string, unknown>,
    browser: PairedBrowser,
    tabId?: number
  ): Promise<unknown>
  vault(request: unknown, browser: PairedBrowser): Promise<unknown>
  /** This browser's latest task started at or after `since` (ms): web_use answers "started" at
   *  once, so a browser waiting on the result asks here. Null when none has started yet. */
  latestTask(browser: PairedBrowser, since: number): Promise<BrowserTaskProgress | null>
  /** Stops a task this browser started (its journey is this browser's). False otherwise. */
  stopTask(browser: PairedBrowser, taskId: string): Promise<boolean>
  /** One section of the desktop's settings (settings.ts), as its Settings screen shows it. */
  readSettings(section: SettingsSection): Promise<unknown>
  /** Apply an already-validated patch through the desktop's own setters. */
  writeSettings(section: SettingsSection, patch: Record<string, unknown>): Promise<void>
}

export interface BridgeDeps {
  readonly keys: CryptoKeyPair
  readonly store: BridgeStore
  /** Show the code and the browser's name in the desktop's own window. True = approved. */
  confirmPairing(code: string, deviceName: string): Promise<boolean>
  readonly data: BridgeData
  now(): number
  newId(): string
}

export type BridgeReply = { status: number; body: unknown }

const UNAUTHORIZED: BridgeReply = { status: 401, body: { error: 'unauthorized' } }

type Handler = (params: Record<string, unknown>, browser: PairedBrowser) => Promise<unknown>

export interface BridgeService {
  info(): Promise<BridgeReply>
  pair(raw: unknown): Promise<BridgeReply>
  rpc(raw: unknown): Promise<BridgeReply>
  /** A paired browser and its session key, for the live socket. Null for an unknown device. */
  linkKey(deviceId: string): Promise<{ browser: PairedBrowser; key: CryptoKey } | null>
  /** True the first time a socket hello nonce is seen inside the freshness window. */
  acceptNonce(deviceId: string, nonce: string): boolean
}

export function createBridgeService(deps: BridgeDeps): BridgeService {
  const replay = new ReplayGuard()
  const sessionKeys = new Map<string, Promise<CryptoKey>>()
  let pairing = false

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

  // Pro features say "pro_required" only when the desktop is not Pro. A Pro desktop that
  // still cannot offer one (an older Pro bundle, no vault set up) says "<feature>_unavailable",
  // so the browser never tells a paying user to upgrade.
  const requireFeature = (feature: keyof BridgeFeatures): void => {
    const features = deps.data.features()
    if (features[feature]) return
    const proOnly = feature === 'vault' || feature === 'tools'
    throw new Error(proOnly && !features.pro ? 'pro_required' : `${feature}_unavailable`)
  }

  const handlers: Record<RpcMethod, Handler> = {
    state: async (_p, browser) => ({
      desktopName: deps.data.desktopName(),
      deviceName: browser.name,
      features: deps.data.features()
    }),
    'conversations.list': async () => deps.data.listConversations(),
    'conversations.put': async (p, browser) => {
      await deps.data.putConversation(p.conversation, browser)
      return true
    },
    'conversations.delete': async (p) => {
      if (typeof p.id !== 'string' || !p.id) {
        throw new Error('invalid')
      }
      await deps.data.deleteConversation(p.id)
      return true
    },
    'tools.list': async () => deps.data.listTools(),
    'tools.run': async (p, browser) => {
      requireFeature('tools')
      if (typeof p.name !== 'string' || typeof p.args !== 'object' || p.args === null) {
        throw new Error('invalid')
      }
      const tabId = p.tabId
      if (tabId !== undefined && !(Number.isSafeInteger(tabId) && Number(tabId) >= 0)) {
        throw new Error('invalid')
      }
      return deps.data.runTool(
        p.name,
        p.args as Record<string, unknown>,
        browser,
        tabId === undefined ? undefined : Number(tabId)
      )
    },
    'tasks.latest': async (p, browser) => {
      requireFeature('tools')
      if (typeof p.since !== 'number' || !Number.isFinite(p.since)) {
        throw new Error('invalid')
      }
      return deps.data.latestTask(browser, p.since)
    },
    'tasks.stop': async (p, browser) => {
      requireFeature('tools')
      if (typeof p.taskId !== 'string' || !/^[\w-]{1,128}$/.test(p.taskId)) {
        throw new Error('invalid')
      }
      return deps.data.stopTask(browser, p.taskId)
    },
    vault: async (p, browser) => {
      requireFeature('vault')
      return deps.data.vault(p.request, browser)
    },
    'settings.get': async (p) => {
      if (!isSettingsSection(p.section)) {
        throw new Error('invalid')
      }
      return deps.data.readSettings(p.section)
    },
    'settings.set': async (p) => {
      const patch = isSettingsSection(p.section) ? parseSettingsPatch(p.section, p.patch) : null
      if (!patch || !isSettingsSection(p.section)) {
        throw new Error('invalid')
      }
      await deps.data.writeSettings(p.section, patch)
      return deps.data.readSettings(p.section)
    },
    unpair: async (_p, browser) => {
      const all = await deps.store.list()
      await deps.store.save(all.filter((b) => b.id !== browser.id))
      sessionKeys.delete(browser.id)
      return true
    }
  }

  return {
    /** Unauthenticated: the desktop's public key and protocol version. Nothing private. */
    async info(): Promise<BridgeReply> {
      return {
        status: 200,
        body: { v: BRIDGE_VERSION, publicKey: await exportPublicKey(deps.keys.publicKey) }
      }
    },

    async pair(raw: unknown): Promise<BridgeReply> {
      const request = parsePairRequest(raw)
      if (!request || !(await importPublicKey(request.publicKey))) {
        return { status: 400, body: { error: 'invalid' } }
      }
      // One prompt at a time: a page or process cannot stack dialogs on the user.
      if (pairing) {
        return { status: 409, body: { error: 'busy' } }
      }
      pairing = true
      try {
        const code = await pairingCode(
          request.publicKey,
          await exportPublicKey(deps.keys.publicKey)
        )
        if (!(await deps.confirmPairing(code, request.deviceName))) {
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
        reply = {
          id: request.id,
          ok: true,
          result: await handlers[request.method](request.params, browser)
        }
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
      return browser ? { browser, key: await sessionKey(browser) } : null
    },

    acceptNonce(deviceId: string, nonce: string): boolean {
      return replay.accept(`${deviceId}:hello:${nonce}`, deps.now())
    }
  }
}
