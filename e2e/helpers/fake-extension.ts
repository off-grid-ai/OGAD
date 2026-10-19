/**
 * A fake paired browser: the Off Grid AI browser extension's side of the Desktop bridge.
 *
 * It speaks the real protocol from src/main/extension-bridge (the same module the extension
 * shares): it pairs over /v1/extension/pair, signs and seals every RPC, opens the live socket with
 * the sealed hello, keeps it alive with pings, offers tabs, and answers the commands Desktop sends
 * down (tabs, page.call). Everything on Desktop's side stays production code. The pairing prompt
 * is a native dialog, so the spec answers it through `answerPairingDialog` the way a person does:
 * Pair only when the dialog shows the same words this browser shows.
 */
import type { ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import {
  BRIDGE_VERSION,
  deriveSessionKey,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
  open,
  pairingCode,
  requestAad,
  responseAad,
  seal
} from '../../src/main/extension-bridge/bridge-protocol'
import {
  createChannel,
  helloAad,
  linkName,
  newNonce,
  parseReady,
  readyAad,
  SOCKET_PATH,
  type SealedChannel
} from '../../src/main/extension-bridge/bridge-socket-protocol'
import { GATEWAY_PORT } from '../../src/shared/ports'

export const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const BASE = `http://127.0.0.1:${GATEWAY_PORT}`

export interface RpcReply {
  status: number
  ok?: boolean
  result?: unknown
  error?: string
}

export interface DownCommand {
  id: number
  op: string
  args: Record<string, unknown>
}

/** What the fake answers for a command Desktop sends down the socket. */
export type CommandAnswer = (command: DownCommand) => unknown | Promise<unknown>

export interface OfferedTab {
  tabId: number
  url: string
  title: string
}

/** The pairing dialog answers Pair only when it shows `code`; any other code is refused. */
export const answerPairingDialog = async (app: ElectronApplication, code: string): Promise<void> =>
  app.evaluate(({ dialog }, expected) => {
    const shown: string[] = []
    ;(globalThis as unknown as { __pairingDialogs: string[] }).__pairingDialogs = shown
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = (args.length > 1 ? args[1] : args[0]) as {
        buttons?: string[]
        detail?: string
        message?: string
      }
      shown.push(`${options.message ?? ''}\n${options.detail ?? ''}`)
      const pair = (options.buttons ?? []).indexOf('Pair')
      const refuse = (options.buttons ?? []).indexOf("Don't pair")
      return {
        response: options.detail?.includes(expected) ? pair : refuse,
        checkboxChecked: false
      }
    }) as never
  }, code)

/** The pairing dialogs shown so far, message and detail. */
export const pairingDialogs = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(
    () => (globalThis as unknown as { __pairingDialogs?: string[] }).__pairingDialogs ?? []
  )

/** A browser paired the way a person pairs one (matching words confirmed), with its socket open. */
export const pairedBrowser = async (
  app: ElectronApplication,
  name = 'E2E Browser'
): Promise<FakeExtension> => {
  const browser = new FakeExtension(name)
  await answerPairingDialog(app, await browser.pairingCode())
  const paired = await browser.pair()
  if (paired.status !== 200) throw new Error(`pairing failed: ${JSON.stringify(paired)}`)
  if (!(await browser.connect())) throw new Error('the paired browser could not connect')
  return browser
}

export class FakeExtension {
  readonly name: string
  deviceId = ''
  tabs: OfferedTab[] = [{ tabId: 101, url: 'https://example.test/', title: 'Example tab' }]
  /** Every command Desktop sent down, in order. */
  readonly commands: DownCommand[] = []
  /** Answers by op; `tabs.list` and `browser.caps` have defaults. */
  readonly answers = new Map<string, CommandAnswer>()
  private keys!: CryptoKeyPair
  private key: CryptoKey | null = null
  private socket: WebSocket | null = null
  private channel: SealedChannel | null = null
  private ping: NodeJS.Timeout | null = null

  constructor(name = 'E2E Browser') {
    this.name = name
  }

  /** The words this browser shows while pairing; Desktop's dialog must show the same. */
  async pairingCode(): Promise<string> {
    this.keys ??= await generateKeyPair(true)
    const info = (await (
      await fetch(`${BASE}/v1/extension/info`, { headers: { origin: EXTENSION_ORIGIN } })
    ).json()) as { publicKey: string }
    return pairingCode(await exportPublicKey(this.keys.publicKey), info.publicKey)
  }

  /** Ask Desktop to pair. Resolves once the person answered Desktop's dialog. */
  async pair(): Promise<{ status: number; error?: string }> {
    this.keys ??= await generateKeyPair(true)
    const response = await fetch(`${BASE}/v1/extension/pair`, {
      method: 'POST',
      headers: { origin: EXTENSION_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({
        v: BRIDGE_VERSION,
        publicKey: await exportPublicKey(this.keys.publicKey),
        deviceName: this.name
      })
    })
    const body = (await response.json()) as { deviceId?: string; error?: string }
    if (response.status !== 200 || !body.deviceId) return { status: response.status, ...body }
    this.deviceId = body.deviceId
    const info = (await (
      await fetch(`${BASE}/v1/extension/info`, { headers: { origin: EXTENSION_ORIGIN } })
    ).json()) as { publicKey: string }
    this.key = await deriveSessionKey(
      this.keys.privateKey,
      (await importPublicKey(info.publicKey))!,
      this.deviceId
    )
    return { status: 200 }
  }

  /** One sealed RPC, as the extension sends it. */
  async rpc(method: string, params: Record<string, unknown> = {}): Promise<RpcReply> {
    if (!this.key) throw new Error('not paired')
    const id = randomUUID()
    const sealed = await seal(this.key, requestAad(this.deviceId), {
      id,
      ts: Date.now(),
      method,
      params
    })
    const response = await fetch(`${BASE}/v1/extension/rpc`, {
      method: 'POST',
      headers: { origin: EXTENSION_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ v: BRIDGE_VERSION, d: this.deviceId, ...sealed })
    })
    const body = (await response.json()) as { n: string; c: string; error?: string }
    if (response.status !== 200) return { status: response.status, error: body.error }
    const reply = (await open(this.key, responseAad(this.deviceId, id), body)) as {
      ok: boolean
      result?: unknown
      error?: string
    }
    return { status: 200, ...reply }
  }

  /** Open the live socket. Resolves true once Desktop answered the hello, false if it refused. */
  async connect(): Promise<boolean> {
    if (!this.key) throw new Error('not paired')
    const socket = new WebSocket(
      `ws://127.0.0.1:${GATEWAY_PORT}${SOCKET_PATH}?d=${this.deviceId}`,
      { origin: EXTENSION_ORIGIN }
    )
    const opened = await Promise.race([
      once(socket, 'open').then(() => true),
      once(socket, 'close').then(() => false),
      once(socket, 'error').then(() => false)
    ])
    if (!opened) return false
    const nonce = newNonce()
    const ready = Promise.race([
      once(socket, 'message').then(([raw]) => String(raw)),
      once(socket, 'close').then(() => null)
    ])
    socket.send(
      JSON.stringify(await seal(this.key, helloAad(this.deviceId), { nonce, ts: Date.now() }))
    )
    const answer = await ready
    if (answer === null) return false
    const desktop = parseReady(
      await open(this.key, readyAad(this.deviceId, nonce), JSON.parse(answer))
    )
    if (!desktop) return false
    const channel = createChannel({
      key: this.key,
      deviceId: this.deviceId,
      link: linkName(nonce, desktop.nonce),
      role: 'browser'
    })
    this.socket = socket
    this.channel = channel
    socket.on('message', (raw) => void this.receive(String(raw)))
    socket.on('close', () => this.stopPing())
    this.ping = setInterval(() => void this.send({ event: 'ping', tabId: 0, data: {} }), 10_000)
    return true
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  /** Resolves when Desktop closes the live socket. */
  closed(): Promise<void> {
    const socket = this.socket
    if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve()
    return once(socket, 'close').then(() => undefined)
  }

  /** Send an unprompted event up (tab.updated, tab.removed, ...). */
  async send(message: unknown): Promise<void> {
    if (!this.channel || !this.connected) return
    this.socket!.send(await this.channel.seal(message))
  }

  async close(): Promise<void> {
    this.stopPing()
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close()
      await once(socket, 'close').catch(() => undefined)
    }
  }

  private stopPing(): void {
    if (this.ping) clearInterval(this.ping)
    this.ping = null
  }

  private async receive(frame: string): Promise<void> {
    const message = (await this.channel!.open(frame)) as DownCommand | null
    if (!message || typeof message.id !== 'number' || typeof message.op !== 'string') return
    this.commands.push(message)
    try {
      const custom = this.answers.get(message.op)
      const result = custom ? await custom(message) : this.defaultAnswer(message)
      await this.send({ id: message.id, ok: true, result })
    } catch (error) {
      await this.send({
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : 'failed'
      })
    }
  }

  private defaultAnswer(command: DownCommand): unknown {
    switch (command.op) {
      case 'browser.caps':
        return { cdp: false }
      case 'tabs.list':
        return this.tabs
      case 'tab.adopt': {
        const offered = this.tabs.find((tab) => tab.tabId === command.args.tabId) ?? this.tabs[0]!
        return typeof command.args.url === 'string'
          ? { ...offered, url: command.args.url }
          : offered
      }
      case 'tab.create': {
        const created = {
          tabId: 200 + this.tabs.length,
          url: typeof command.args.url === 'string' ? command.args.url : 'about:blank',
          title: 'New tab'
        }
        this.tabs.push(created)
        return created
      }
      case 'tab.close':
        return true
      case 'page.call':
        return { text: `- Page: ${this.tabs[0]?.title ?? ''}`, isError: false }
      default:
        throw new Error(`unsupported: ${command.op}`)
    }
  }
}
