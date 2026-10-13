import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { guardConsoleStreams, guardProxyStreams } from '../stream-guards'

// Fails-before / passes-after: a Node EventEmitter throws on emit('error') when there is NO
// 'error' listener. That is exactly why an EPIPE on stdout crashed the main process. The guard
// installs a listener so the same emit is swallowed instead of thrown.

describe('guardConsoleStreams', () => {
  it('makes an EPIPE emit on a console stream non-fatal (would throw without the guard)', () => {
    const stream = new EventEmitter()
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })

    // Sanity: before guarding, emitting 'error' with no listener throws (the crash we saw).
    expect(() => stream.emit('error', epipe)).toThrow(/EPIPE/)

    // After guarding, the same emit is swallowed — no throw.
    const guarded = guardConsoleStreams([stream])
    expect(guarded).toBe(1)
    expect(() => stream.emit('error', epipe)).not.toThrow()
  })

  it('guards every provided stream and skips undefined/invalid ones', () => {
    const a = new EventEmitter()
    const b = new EventEmitter()
    expect(guardConsoleStreams([a, undefined, b, {} as never])).toBe(2)
    expect(() => a.emit('error', new Error('x'))).not.toThrow()
    expect(() => b.emit('error', new Error('y'))).not.toThrow()
  })
})

// Regression for the proxyToLlama mid-stream crash: proxyRes.pipe(res) wired the pipe but neither
// stream had an 'error' listener, so an upstream reset (llama-server aborting mid-stream) or a
// client disconnect turned the unhandled 'error' event into an uncaught exception that took the
// whole main process down. guardProxyStreams installs listeners on both ends.
describe('guardProxyStreams', () => {
  it('makes an upstream reset non-fatal and tears down the client response (would throw without the guard)', () => {
    const upstream = new EventEmitter()
    const client = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })

    // Sanity: before guarding, an upstream 'error' with no listener throws (the crash we saw).
    expect(() => upstream.emit('error', reset)).toThrow(/ECONNRESET/)

    // After guarding, the same emit is swallowed and the client response is destroyed to free it.
    const guarded = guardProxyStreams(upstream, client)
    expect(guarded).toBe(2)
    expect(() => upstream.emit('error', reset)).not.toThrow()
    expect(client.destroy).toHaveBeenCalledTimes(1)
  })

  it('stops the model when a client goes away cleanly, not only on a socket error', () => {
    // A browser's Stop, or a closed panel, ends the request with 'close' and no 'error'. The
    // engine kept generating for nobody (a thinking loop held its only slot until the context
    // filled) and every later request queued behind it.
    const upstream = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    const client = Object.assign(new EventEmitter(), { writableEnded: false })
    guardProxyStreams(upstream, client)
    client.emit('close')
    expect(upstream.destroy).toHaveBeenCalledTimes(1)
  })

  it('leaves the upstream alone when the response finished normally', () => {
    const upstream = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    const client = Object.assign(new EventEmitter(), { writableEnded: true })
    guardProxyStreams(upstream, client)
    client.emit('close')
    expect(upstream.destroy).not.toHaveBeenCalled()
  })

  it('makes a client disconnect non-fatal AND tears down the upstream (stops reading llama-server)', () => {
    const upstream = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    const client = new EventEmitter()
    const guarded = guardProxyStreams(upstream, client)
    expect(guarded).toBe(2)
    // A client disconnect must not throw...
    expect(() => client.emit('error', new Error('EPIPE'))).not.toThrow()
    // ...and must destroy the upstream, else proxyRes.pipe(res) keeps draining llama-server
    // after the client is gone (wasted local inference + a held socket).
    expect(upstream.destroy).toHaveBeenCalledTimes(1)
  })

  it('a client disconnect with no upstream is still non-fatal', () => {
    const client = new EventEmitter()
    guardProxyStreams(undefined, client)
    expect(() => client.emit('error', new Error('EPIPE'))).not.toThrow()
  })

  it('tolerates a client with no destroy method (does not throw when tearing down)', () => {
    const upstream = new EventEmitter()
    const client = new EventEmitter() // no destroy()
    expect(guardProxyStreams(upstream, client)).toBe(2)
    expect(() => upstream.emit('error', new Error('reset'))).not.toThrow()
  })

  it('skips undefined streams and counts only the guarded ones', () => {
    expect(guardProxyStreams(undefined, undefined)).toBe(0)
    expect(guardProxyStreams(new EventEmitter(), undefined)).toBe(1)
  })
})
