import { describe, expect, it } from 'vitest'
import { OAuthPkceVerifier } from '../mcp-oauth-pkce'

describe('OAuth PKCE verifier lifecycle', () => {
  it('keeps the verifier when the SDK invalidates all credentials before an exchange retry', () => {
    const verifier = new OAuthPkceVerifier()
    verifier.save('attempt-verifier')

    verifier.invalidate('all')

    expect(verifier.read()).toBe('attempt-verifier')
  })

  it('clears the verifier after tokens are saved', () => {
    const verifier = new OAuthPkceVerifier()
    verifier.save('attempt-verifier')

    verifier.complete()

    expect(() => verifier.read()).toThrow('missing PKCE code verifier')
  })

  it('clears the verifier when authorization is cancelled', () => {
    const verifier = new OAuthPkceVerifier()
    verifier.save('attempt-verifier')

    verifier.cancel()

    expect(() => verifier.read()).toThrow('missing PKCE code verifier')
  })

  it('honors explicit verifier invalidation during an active attempt', () => {
    const verifier = new OAuthPkceVerifier()
    verifier.save('attempt-verifier')

    verifier.invalidate('verifier')

    expect(() => verifier.read()).toThrow('missing PKCE code verifier')
  })
})
