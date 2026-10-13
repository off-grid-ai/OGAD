import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OAuthLoopbackServer } from '../mcp-oauth-loopback'

describe('OAuth loopback callback lifecycle', () => {
  let loopback: OAuthLoopbackServer

  beforeEach(async () => {
    loopback = new OAuthLoopbackServer({
      port: 0,
      authorizationTimeoutMs: 5_000,
      renderCompletionPage: (error) => (error ? `failed:${error}` : 'connected')
    })
    await loopback.start()
  })

  afterEach(async () => {
    await loopback.stop()
  })

  it('keeps a pending request alive after missing and wrong states, then accepts its exact state', async () => {
    const code = loopback.awaitCode('expected-state')

    const missing = await fetch(`${loopback.redirectUrl}?code=attacker-code`)
    const wrong = await fetch(`${loopback.redirectUrl}?state=wrong-state&code=attacker-code`)
    const correct = await fetch(`${loopback.redirectUrl}?state=expected-state&code=provider-code`)

    expect(missing.status).toBe(400)
    expect(await missing.text()).toContain('failed:Invalid or expired authorization response')
    expect(wrong.status).toBe(400)
    expect(await wrong.text()).toContain('failed:Invalid or expired authorization response')
    expect(correct.status).toBe(200)
    await expect(code).resolves.toBe('provider-code')
  })

  it('consumes a valid state once and rejects a replayed callback', async () => {
    const code = loopback.awaitCode('one-time-state')

    const first = await fetch(`${loopback.redirectUrl}?state=one-time-state&code=first-code`)
    const replay = await fetch(`${loopback.redirectUrl}?state=one-time-state&code=replayed-code`)

    expect(first.status).toBe(200)
    await expect(code).resolves.toBe('first-code')
    expect(replay.status).toBe(400)
    expect(await replay.text()).toContain('failed:Invalid or expired authorization response')
  })

  it('removes an expired state and does not admit a late callback', async () => {
    const code = loopback.awaitCode('expired-state', 10)

    await expect(code).rejects.toThrow('Authorization timed out')
    const late = await fetch(`${loopback.redirectUrl}?state=expired-state&code=late-code`)

    expect(late.status).toBe(400)
    expect(await late.text()).toContain('failed:Invalid or expired authorization response')
  })

  it('routes concurrent callbacks only to their exact pending requests', async () => {
    const firstCode = loopback.awaitCode('first-state')
    const secondCode = loopback.awaitCode('second-state')

    await fetch(`${loopback.redirectUrl}?state=second-state&code=second-code`)
    await fetch(`${loopback.redirectUrl}?state=first-state&code=first-code`)

    await expect(firstCode).resolves.toBe('first-code')
    await expect(secondCode).resolves.toBe('second-code')
  })

  it('consumes the exact state when the provider returns an error', async () => {
    const code = loopback.awaitCode('denied-state')
    const rejection = expect(code).rejects.toThrow('OAuth error: access_denied')

    const denied = await fetch(`${loopback.redirectUrl}?state=denied-state&error=access_denied`)

    expect(denied.status).toBe(200)
    expect(await denied.text()).toContain('failed:access_denied')
    await rejection
    const replay = await fetch(`${loopback.redirectUrl}?state=denied-state&code=ignored`)
    expect(replay.status).toBe(400)
  })

  it('consumes an exact state when the provider omits both code and error', async () => {
    const code = loopback.awaitCode('malformed-state')
    const rejection = expect(code).rejects.toThrow('No authorization code in redirect')

    const malformed = await fetch(`${loopback.redirectUrl}?state=malformed-state`)

    expect(malformed.status).toBe(400)
    await rejection
    const replay = await fetch(`${loopback.redirectUrl}?state=malformed-state&code=ignored`)
    expect(replay.status).toBe(400)
  })

  it('rejects missing and duplicate registrations without replacing the original request', async () => {
    expect(() => loopback.awaitCode('')).toThrow('OAuth authorization URL is missing state')
    const original = loopback.awaitCode('duplicate-state')
    expect(() => loopback.awaitCode('duplicate-state')).toThrow(
      'OAuth authorization state is already pending'
    )

    await fetch(`${loopback.redirectUrl}?state=duplicate-state&code=original-code`)
    await expect(original).resolves.toBe('original-code')
  })

  it('cancels only the named request and leaves concurrent authorization intact', async () => {
    const cancelled = loopback.awaitCode('cancelled-state')
    const surviving = loopback.awaitCode('surviving-state')
    const cancellation = expect(cancelled).rejects.toThrow('Authorization superseded')

    loopback.cancel('cancelled-state', new Error('Authorization superseded'))
    loopback.cancel('unknown-state', new Error('Must not affect another request'))
    await fetch(`${loopback.redirectUrl}?state=surviving-state&code=surviving-code`)

    await cancellation
    await expect(surviving).resolves.toBe('surviving-code')
  })

  it('rejects pending requests on shutdown and can start cleanly again', async () => {
    const pending = loopback.awaitCode('shutdown-state')
    const stopped = expect(pending).rejects.toThrow('OAuth callback server stopped')

    await loopback.stop()
    await stopped
    await loopback.start()
    const restarted = loopback.awaitCode('restarted-state')
    await fetch(`${loopback.redirectUrl}?state=restarted-state&code=restarted-code`)

    await expect(restarted).resolves.toBe('restarted-code')
  })

  it('serves the configured logo without changing pending authorization state', async () => {
    await loopback.stop()
    loopback = new OAuthLoopbackServer({
      port: 0,
      renderCompletionPage: (error) => (error ? `failed:${error}` : 'connected'),
      logoBytes: () => Buffer.from('brand-logo')
    })
    await loopback.start()
    const code = loopback.awaitCode('logo-state')

    const logo = await fetch(new URL('/oglogo.png', loopback.redirectUrl))
    await fetch(`${loopback.redirectUrl}?state=logo-state&code=provider-code`)

    expect(logo.status).toBe(200)
    expect(logo.headers.get('content-type')).toBe('image/png')
    expect(await logo.text()).toBe('brand-logo')
    await expect(code).resolves.toBe('provider-code')
  })

  it('rejects pending authorization when the callback port cannot be bound', async () => {
    const occupiedPort = Number(new URL(loopback.redirectUrl).port)
    const observedErrors: Error[] = []
    const blocked = new OAuthLoopbackServer({
      port: occupiedPort,
      renderCompletionPage: () => 'unused',
      onError: (error) => observedErrors.push(error)
    })
    const pending = blocked.awaitCode('blocked-state')
    const callbackFailure = expect(pending).rejects.toThrow('OAuth callback server unavailable')

    await expect(blocked.start()).rejects.toMatchObject({
      code: 'EADDRINUSE',
      message: expect.stringContaining('If another Off Grid AI window is open, close it')
    })

    await callbackFailure
    expect(observedErrors).toHaveLength(1)
    await blocked.stop()
  })

  it('requires the exact callback path', async () => {
    await expect(loopback.start()).resolves.toBeUndefined()
    const code = loopback.awaitCode('path-state')

    const lookalike = await fetch(
      `${loopback.redirectUrl}-lookalike?state=path-state&code=attacker-code`
    )
    const correct = await fetch(`${loopback.redirectUrl}?state=path-state&code=provider-code`)

    expect(lookalike.status).toBe(404)
    const absentLogo = await fetch(new URL('/oglogo.png', loopback.redirectUrl))
    expect(absentLogo.status).toBe(404)
    expect(correct.status).toBe(200)
    await expect(code).resolves.toBe('provider-code')
  })
})
