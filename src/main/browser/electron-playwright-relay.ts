/** A target-scoped CDP relay that exposes only one Web Use journey. */
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import {
  ElectronPlaywrightAttachments,
  type ElectronPlaywrightPageProvider
} from './electron-playwright-attachments'
import {
  asBoundaryError,
  closeRelaySocket,
  parseCdpCommand,
  safeTargetUrl,
  sendCdpEvent,
  type CdpCommand,
  type CdpEvent
} from './electron-playwright-relay-protocol'
import { runBounded } from './playwright-boundary-wait'

export type { ElectronPlaywrightPageProvider } from './electron-playwright-attachments'

const PRODUCT = 'Chrome/OffGrid-WebUse'
const START_TIMEOUT_MS = 5_000
const BOUNDARY_TIMEOUT_MS = 15_000
const CLOSE_TIMEOUT_MS = 5_000
const DISCOVERY_COMMANDS = new Set([
  'Target.setDiscoverTargets',
  'Target.getTargets',
  'Target.setAutoAttach',
  'Target.attachToTarget'
])

export class ElectronPlaywrightRelay {
  private readonly path = `/cdp/${randomUUID()}`
  private readonly attachments: ElectronPlaywrightAttachments
  private server: WebSocketServer | null = null
  private client: WebSocket | null = null
  private endpointValue = ''
  private autoAttach = false
  private failure: Error | null = null
  private messageQueue: Promise<void> = Promise.resolve()

  constructor(private readonly provider: ElectronPlaywrightPageProvider) {
    this.attachments = new ElectronPlaywrightAttachments(
      provider,
      (event) => this.send(event),
      (error) => this.fail(error, 'Electron debugger failed')
    )
  }

  async start(): Promise<string> {
    if (this.server) {
      this.ensureHealthy()
      return this.endpointValue
    }
    this.failure = null
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: this.path })
    this.server = server
    server.on('connection', (socket) => this.accept(socket))
    server.on('error', (error) => this.fail(error, 'Playwright relay server failed'))
    try {
      await runBounded({
        label: 'Playwright relay listen',
        timeoutMs: START_TIMEOUT_MS,
        run: () =>
          new Promise<void>((resolve, reject) => {
            server.once('listening', resolve)
            server.once('error', reject)
          })
      })
      this.ensureHealthy()
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Relay has no TCP address.')
      this.endpointValue = `ws://127.0.0.1:${(address as AddressInfo).port}${this.path}`
      return this.endpointValue
    } catch (error) {
      await this.stop().catch(() => undefined)
      throw error
    }
  }

  async syncPages(): Promise<void> {
    this.ensureHealthy()
    if (!this.autoAttach) return
    await this.attachments.sync()
  }

  async stop(): Promise<void> {
    const errors: Error[] = []
    const client = this.client
    this.client = null
    if (client) {
      try {
        await closeRelaySocket(client, CLOSE_TIMEOUT_MS)
      } catch (error) {
        errors.push(asBoundaryError(error))
      }
    }
    this.attachments.clear()
    this.autoAttach = false
    this.messageQueue = Promise.resolve()

    const server = this.server
    this.server = null
    this.endpointValue = ''
    if (server) {
      try {
        await runBounded({
          label: 'Playwright relay close',
          timeoutMs: CLOSE_TIMEOUT_MS,
          run: () =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve()))
            )
        })
      } catch (error) {
        errors.push(asBoundaryError(error))
      } finally {
        server.removeAllListeners()
      }
    }
    this.failure = null
    if (errors.length) throw errors[0]
  }

  private accept(socket: WebSocket): void {
    if (this.client) {
      socket.close(1008, 'A Web Use client is already connected')
      return
    }
    this.client = socket
    const onMessage = (data: RawData): void => {
      this.messageQueue = this.messageQueue
        .then(() => this.receive(socket, data))
        .catch((error) => this.fail(asBoundaryError(error), 'Playwright relay command failed'))
    }
    const onError = (error: Error): void => this.fail(error, 'Playwright relay socket failed')
    const onClose = (): void => {
      socket.off('message', onMessage)
      socket.off('error', onError)
      socket.off('close', onClose)
      if (this.client === socket) this.client = null
      this.autoAttach = false
      this.attachments.clear()
    }
    socket.on('message', onMessage)
    socket.on('error', onError)
    socket.on('close', onClose)
  }

  private async receive(socket: WebSocket, data: RawData): Promise<void> {
    let id = 0
    let sessionId: string | undefined
    try {
      const command = parseCdpCommand(JSON.parse(data.toString()) as unknown)
      id = command.id
      sessionId = command.sessionId
      const result = await runBounded({
        label: `CDP ${command.method}`,
        timeoutMs: BOUNDARY_TIMEOUT_MS,
        run: () => this.command(command)
      })
      await sendCdpEvent(socket, { id, sessionId, result }, BOUNDARY_TIMEOUT_MS)
    } catch (error) {
      await sendCdpEvent(
        socket,
        { id, sessionId, error: { message: asBoundaryError(error).message } },
        BOUNDARY_TIMEOUT_MS
      ).catch(() => undefined)
    }
  }

  private async command(command: CdpCommand): Promise<unknown> {
    const { method, params, sessionId } = command
    if (method === 'Browser.getVersion') {
      return {
        protocolVersion: '1.3',
        product: PRODUCT,
        revision: 'offgrid',
        userAgent: PRODUCT,
        jsVersion: process.versions.v8
      }
    }
    if (method === 'Browser.setDownloadBehavior') return {}
    if (method.startsWith('Target.')) return this.targetCommand(method, params, sessionId)
    return this.forward(method, params, sessionId)
  }

  private async targetCommand(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined
  ): Promise<unknown> {
    return DISCOVERY_COMMANDS.has(method)
      ? this.discoveryCommand(method, params, sessionId)
      : this.targetLifecycleCommand(method, params, sessionId)
  }

  private async discoveryCommand(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined
  ): Promise<unknown> {
    switch (method) {
      case 'Target.setDiscoverTargets':
        return {}
      case 'Target.getTargets':
        return { targetInfos: this.attachments.pages().map((page) => this.attachments.info(page)) }
      case 'Target.setAutoAttach':
        if (sessionId) return this.forward(method, params, sessionId)
        this.autoAttach = true
        await this.syncPages()
        return {}
      case 'Target.attachToTarget': {
        const page = this.attachments.forTarget(String(params.targetId ?? ''))
        if (!page) throw new Error('The requested target is outside this Web Use journey.')
        await this.attachments.attach(page)
        return { sessionId: this.attachments.attachedPage(page.id)?.sessionId }
      }
      default:
        throw new Error(`Unknown target discovery command ${method}.`)
    }
  }

  private async targetLifecycleCommand(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined
  ): Promise<unknown> {
    switch (method) {
      case 'Target.createTarget':
        return this.createTarget(params.url)
      case 'Target.closeTarget':
        return this.closeTarget(String(params.targetId ?? ''))
      case 'Target.getTargetInfo': {
        if (!sessionId && !params.targetId) return { targetInfo: undefined }
        const page = sessionId
          ? this.attachments.forSession(sessionId)
          : this.attachments.forTarget(String(params.targetId ?? ''))
        if (!page) throw new Error('The requested target is outside this Web Use journey.')
        return { targetInfo: this.attachments.info(page) }
      }
      case 'Target.activateTarget': {
        const page = this.attachments.forTarget(String(params.targetId ?? ''))
        if (!page) throw new Error('The requested target is outside this Web Use journey.')
        return this.forward(
          'Page.bringToFront',
          {},
          this.attachments.attachedPage(page.id)?.sessionId
        )
      }
      default:
        if (!sessionId) throw new Error(`Root CDP command ${method} is not allowed.`)
        return this.forward(method, params, sessionId)
    }
  }

  private async createTarget(url: unknown): Promise<{ targetId: string }> {
    const page = await runBounded({
      label: 'Create Web Use page',
      timeoutMs: BOUNDARY_TIMEOUT_MS,
      run: () => this.provider.create(safeTargetUrl(url))
    })
    if (!this.provider.pages().some((candidate) => candidate.id === page.id)) {
      await runBounded({
        label: 'Discard unregistered Web Use page',
        timeoutMs: BOUNDARY_TIMEOUT_MS,
        run: () => this.provider.close(page.id)
      }).catch(() => undefined)
      throw new Error('The page provider did not register the new journey target.')
    }
    await this.syncPages()
    return { targetId: this.attachments.targetId(page.id) }
  }

  private async closeTarget(targetId: string): Promise<{ success: boolean }> {
    const page = this.attachments.forTarget(targetId)
    if (!page) return { success: false }
    await runBounded({
      label: 'Close Web Use page',
      timeoutMs: BOUNDARY_TIMEOUT_MS,
      run: () => this.provider.close(page.id)
    })
    this.attachments.detach(page.id)
    return { success: true }
  }

  private forward(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined
  ): Promise<unknown> {
    if (!sessionId) throw new Error(`CDP command ${method} requires a journey target session.`)
    const page = this.attachments.forSession(sessionId)
    if (!page) throw new Error(`CDP session ${sessionId} is outside this Web Use journey.`)
    const childSession = page.sessionId === sessionId ? undefined : sessionId
    return runBounded({
      label: `Electron debugger ${method}`,
      timeoutMs: BOUNDARY_TIMEOUT_MS,
      run: () => page.contents.debugger.sendCommand(method, params, childSession)
    })
  }

  private async send(message: CdpEvent): Promise<void> {
    const client = this.client
    if (!client || client.readyState !== WebSocket.OPEN) return
    await sendCdpEvent(client, message, BOUNDARY_TIMEOUT_MS)
  }

  private fail(error: Error, context: string): void {
    this.failure = new Error(`${context}: ${error.message}`, { cause: error })
    this.client?.terminate()
  }

  private ensureHealthy(): void {
    if (this.failure) throw this.failure
  }
}
