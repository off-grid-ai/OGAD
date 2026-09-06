import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, type RawData } from 'ws'
import { ElectronPlaywrightRelay } from '../electron-playwright-relay'
import { parseSemanticDecision, type SemanticDecision } from '../browser-playwright-policy'
import { runBounded } from '../playwright-boundary-wait'

const SNAPSHOT = `- page "Checkout"
  - heading "Order complete"
  - link "View receipt" [ref=receipt-7]`

describe('Web Use provider-output boundary', () => {
  it('accepts a semantic action only when every required field is valid', () => {
    const decision = parseSemanticDecision(decisionValue({ action: 'click' }), SNAPSHOT)

    expect(decision.action).toBe('click')
    expect(decision.ref).toBe('receipt-7')
  })

  it('fails closed on unknown fields and missing action inputs', () => {
    expect(() =>
      parseSemanticDecision({ ...decisionValue({ action: 'click' }), injected: true }, SNAPSHOT)
    ).toThrow(/unknown field injected/)
    expect(() =>
      parseSemanticDecision(decisionValue({ action: 'click', ref: null }), SNAPSHOT)
    ).toThrow(/click requires ref/)
    expect(() =>
      parseSemanticDecision(
        decisionValue({ action: 'navigate', url: 'file:///etc/passwd' }),
        SNAPSHOT
      )
    ).toThrow(/HTTP or HTTPS/)
  })

  it('does not accept model-reported completion without current-page evidence', () => {
    expect(() =>
      parseSemanticDecision(
        decisionValue({
          action: 'done',
          summary: 'The order is complete.',
          evidence_text: 'A claim that is not on the page',
          ref: null,
          element: null
        }),
        SNAPSHOT
      )
    ).toThrow(/exact evidence/)

    expect(
      parseSemanticDecision(
        decisionValue({
          action: 'done',
          summary: 'The order is complete.',
          evidence_text: 'Order complete',
          ref: null,
          element: null
        }),
        SNAPSHOT
      ).summary
    ).toBe('The order is complete.')
  })
})

describe('journey-scoped Electron Playwright relay', () => {
  const openRelays: ElectronPlaywrightRelay[] = []
  const openSockets: WebSocket[] = []

  afterEach(async () => {
    for (const socket of openSockets.splice(0)) socket.terminate()
    for (const relay of openRelays.splice(0)) await relay.stop().catch(() => undefined)
  })

  it('exposes only provider-owned pages and rejects other target sessions', async () => {
    const page = new FakeWebContents('https://example.test/account')
    const providerPages = [{ id: 7, contents: page as unknown as WebContents }]
    const relay = new ElectronPlaywrightRelay({
      pages: () => providerPages,
      create: async () => providerPages[0]!,
      close: async () => undefined
    })
    openRelays.push(relay)
    const socket = await connectSocket(await relay.start())
    openSockets.push(socket)

    const otherClient = new WebSocket(await relay.start())
    const closeCode = await new Promise<number>((resolve, reject) => {
      otherClient.once('close', resolve)
      otherClient.once('error', reject)
    })
    expect(closeCode).toBe(1008)

    await request(socket, 1, 'Target.setAutoAttach', {})
    const targets = await request(socket, 2, 'Target.getTargets', {})
    expect(targets.result).toEqual({
      targetInfos: [
        expect.objectContaining({
          targetId: 'offgrid-target-7',
          url: 'https://example.test/account',
          browserContextId: 'offgrid-journey-context'
        })
      ]
    })

    const allowed = await request(
      socket,
      3,
      'Runtime.evaluate',
      { expression: 'document.title' },
      'offgrid-page-7'
    )
    expect(allowed.error).toBeUndefined()
    expect(page.debuggerApi.commands).toEqual([
      { method: 'Runtime.evaluate', params: { expression: 'document.title' }, sessionId: undefined }
    ])

    const foreign = await request(socket, 4, 'Runtime.evaluate', {}, 'offgrid-page-999')
    expect(foreign.error?.message).toMatch(/outside this Web Use journey/)
    const root = await request(socket, 5, 'Runtime.evaluate', {})
    expect(root.error?.message).toMatch(/requires a journey target session/)
    expect(page.debuggerApi.commands).toHaveLength(1)
  })

  it('removes debugger and WebContents listeners after a renderer failure', async () => {
    const page = new FakeWebContents('https://example.test/')
    const providerPages = [{ id: 8, contents: page as unknown as WebContents }]
    const relay = new ElectronPlaywrightRelay({
      pages: () => providerPages,
      create: async () => providerPages[0]!,
      close: async () => undefined
    })
    openRelays.push(relay)
    const socket = await connectSocket(await relay.start())
    openSockets.push(socket)
    await request(socket, 1, 'Target.setAutoAttach', {})

    page.emit('render-process-gone')
    const targets = await request(socket, 2, 'Target.getTargets', {})

    expect(targets.result).toEqual({ targetInfos: [] })
    expect(page.debuggerApi.isAttached()).toBe(false)
    expect(page.listenerCount('destroyed')).toBe(0)
    expect(page.listenerCount('render-process-gone')).toBe(0)
    expect(page.listenerCount('unresponsive')).toBe(0)
    expect(page.debuggerApi.listenerCount('message')).toBe(0)
    expect(page.debuggerApi.listenerCount('detach')).toBe(0)
  })
})

describe('Playwright boundary waits', () => {
  it('ends a stuck external wait and aborts its boundary work', async () => {
    let boundarySignal: AbortSignal | undefined
    const result = runBounded({
      label: 'stuck browser boundary',
      timeoutMs: 5,
      run: (signal) => {
        boundarySignal = signal
        return new Promise<never>(() => undefined)
      }
    })

    await expect(result).rejects.toThrow('stuck browser boundary timed out')
    expect(boundarySignal?.aborted).toBe(true)
  })
})

function decisionValue(overrides: Partial<SemanticDecision>): Record<string, unknown> {
  return {
    action: 'click',
    phase_id: 'phase-1',
    element: 'View receipt',
    ref: 'receipt-7',
    text: null,
    key: null,
    values: null,
    start_element: null,
    start_ref: null,
    end_element: null,
    end_ref: null,
    url: null,
    evidence_ref: null,
    evidence_text: null,
    reason: '',
    summary: 'Open the receipt',
    ...overrides
  }
}

class FakeDebugger extends EventEmitter {
  readonly commands: Array<{
    method: string
    params: Record<string, unknown>
    sessionId: string | undefined
  }> = []
  private attached = false

  isAttached(): boolean {
    return this.attached
  }

  attach(): void {
    this.attached = true
  }

  detach(): void {
    this.attached = false
  }

  async sendCommand(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string
  ): Promise<Record<string, unknown>> {
    this.commands.push({ method, params, sessionId })
    return { acknowledged: true }
  }
}

class FakeWebContents extends EventEmitter {
  readonly debuggerApi = new FakeDebugger()
  readonly debugger = this.debuggerApi
  private destroyed = false

  constructor(private readonly url: string) {
    super()
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  getTitle(): string {
    return 'Journey page'
  }

  getURL(): string {
    return this.url
  }
}

interface CdpResponse {
  id?: number
  result?: unknown
  error?: { message: string }
}

async function connectSocket(endpoint: string): Promise<WebSocket> {
  const socket = new WebSocket(endpoint)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return socket
}

async function request(
  socket: WebSocket,
  id: number,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string
): Promise<CdpResponse> {
  return new Promise<CdpResponse>((resolve, reject) => {
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onMessage = (data: RawData): void => {
      const message = JSON.parse(data.toString()) as CdpResponse
      if (message.id !== id) return
      cleanup()
      resolve(message)
    }
    const cleanup = (): void => {
      socket.off('error', onError)
      socket.off('message', onMessage)
    }
    socket.on('error', onError)
    socket.on('message', onMessage)
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}
