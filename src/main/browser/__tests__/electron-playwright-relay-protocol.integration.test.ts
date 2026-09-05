/**
 * Real Desktop CDP relay protocol over a loopback WebSocket. The operating-system socket is the
 * external boundary; parsing, bounded delivery, serialization, and graceful close stay real.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import {
  asBoundaryError,
  closeRelaySocket,
  parseCdpCommand,
  safeTargetUrl,
  sendCdpEvent
} from '../electron-playwright-relay-protocol'

const servers: WebSocketServer[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate()
          server.close(() => resolve())
        })
    )
  )
})

describe('Desktop Playwright relay protocol', () => {
  it('delivers a CDP event through a real loopback socket and closes it cleanly', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (typeof address === 'string') throw new Error('Expected a TCP WebSocket listener.')

    const accepted = new Promise<WebSocket>((resolve) => server.once('connection', resolve))
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`)
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })
    const peer = await accepted
    const received = new Promise<string>((resolve) =>
      peer.once('message', (data) => resolve(data.toString()))
    )

    await sendCdpEvent(
      client,
      {
        sessionId: 'offgrid-page-4',
        method: 'Runtime.consoleAPICalled',
        params: { type: 'log' }
      },
      1_000
    )

    expect(JSON.parse(await received)).toEqual({
      sessionId: 'offgrid-page-4',
      method: 'Runtime.consoleAPICalled',
      params: { type: 'log' }
    })
    await closeRelaySocket(client, 1_000)
    expect(client.readyState).toBe(WebSocket.CLOSED)
    await closeRelaySocket(client, 1_000)
  })

  it('accepts the public command shape and rejects malformed or unsafe boundary input', async () => {
    expect(
      parseCdpCommand({
        id: 8,
        sessionId: 'offgrid-page-4',
        method: 'Page.navigate',
        params: { url: 'https://example.com' }
      })
    ).toEqual({
      id: 8,
      sessionId: 'offgrid-page-4',
      method: 'Page.navigate',
      params: { url: 'https://example.com' }
    })
    expect(safeTargetUrl('https://example.com/research?q=off grid')).toBe(
      'https://example.com/research?q=off%20grid'
    )
    expect(safeTargetUrl(undefined)).toBe('about:blank')
    expect(asBoundaryError('socket failed')).toEqual(new Error('socket failed'))

    expect(() => parseCdpCommand(null)).toThrow('Malformed CDP command.')
    expect(() => parseCdpCommand({ id: -1, method: 'Page.navigate' })).toThrow(
      'CDP command requires a non-negative integer id.'
    )
    expect(() => parseCdpCommand({ id: 1, method: '  ' })).toThrow('CDP command requires a method.')
    expect(() => parseCdpCommand({ id: 1, method: 'Page.navigate', sessionId: 3 })).toThrow(
      'CDP session id must be a string.'
    )
    expect(() => parseCdpCommand({ id: 1, method: 'Page.navigate', params: [] })).toThrow(
      'CDP command params must be an object.'
    )
    expect(() => safeTargetUrl('file:///private/data')).toThrow(
      'Web Use targets accept only HTTP or HTTPS URLs.'
    )
    const unopened = new WebSocket('ws://127.0.0.1:1')
    unopened.on('error', () => undefined)
    await expect(sendCdpEvent(unopened, { method: 'Page.loadEventFired' }, 100)).rejects.toThrow(
      'Playwright relay socket is not open.'
    )
    unopened.terminate()
  })
})
