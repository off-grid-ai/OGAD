import { beforeEach, describe, expect, it, vi } from 'vitest'

const secrets = vi.hoisted(() => new Map<string, string>())
vi.mock('../secrets', () => ({
  getSecret: (k: string) => secrets.get(k) ?? null,
  setSecret: (k: string, v: string) => void secrets.set(k, v),
  deleteSecret: (k: string) => void secrets.delete(k)
}))
const opened = vi.hoisted(() => [] as string[])
vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => '/tmp' },
  shell: { openExternal: async (url: string) => void opened.push(url) }
}))
const loopback = vi.hoisted(() => ({
  started: 0,
  awaited: [] as string[],
  cancelled: [] as string[],
  resolve: null as null | ((code: string) => void)
}))
vi.mock('../mcp-oauth-loopback', () => ({
  OAuthLoopbackServer: class {
    redirectUrl = 'http://127.0.0.1:7979/callback'
    async start(): Promise<void> {
      loopback.started++
    }
    awaitCode(state: string): Promise<string> {
      loopback.awaited.push(state)
      return new Promise<string>((resolve) => {
        loopback.resolve = resolve
      })
    }
    cancel(state: string): void {
      loopback.cancelled.push(state)
    }
  }
}))
vi.mock('../mcp-oauth-cancellation', () => ({ beginOAuthAuthorization: () => () => {} }))

import { hasOAuthTokens, makeOAuthProvider } from '../mcp-oauth'

beforeEach(() => {
  secrets.clear()
  opened.length = 0
  loopback.awaited.length = 0
  loopback.cancelled.length = 0
})

describe('connector OAuth provider', () => {
  it('registers dynamically without a static client and persists client and tokens per connector', () => {
    const provider = makeOAuthProvider(7)
    expect(provider.redirectUrl).toBe('http://127.0.0.1:7979/callback')
    expect(provider.clientMetadata).toMatchObject({
      token_endpoint_auth_method: 'none',
      client_name: 'Off Grid AI Desktop'
    })
    expect(provider.clientInformation()).toBeUndefined()
    provider.saveClientInformation!({ client_id: 'dyn' })
    expect(provider.clientInformation()).toEqual({ client_id: 'dyn' })
    expect(hasOAuthTokens(7)).toBe(false)
    provider.saveTokens({ access_token: 't', token_type: 'bearer' })
    expect(provider.tokens()).toEqual({ access_token: 't', token_type: 'bearer' })
    expect(hasOAuthTokens(7)).toBe(true)
    provider.invalidateCredentials('tokens')
    expect(provider.tokens()).toBeUndefined()
    expect(provider.clientInformation()).toEqual({ client_id: 'dyn' })
    provider.invalidateCredentials('all')
    expect(provider.clientInformation()).toBeUndefined()
    expect(provider.state!()).toMatch(/^[0-9a-f]{32}$/)
  })

  it('pins a static Google client: no registration, secret on token exchange, least-privilege scope', () => {
    const provider = makeOAuthProvider(3, { client_id: 'g', client_secret: 's', scope: 'read' })
    expect(provider.clientMetadata).toMatchObject({
      token_endpoint_auth_method: 'client_secret_post',
      scope: 'read'
    })
    expect(provider.clientInformation()).toEqual({ client_id: 'g', client_secret: 's' })
    provider.saveClientInformation!({ client_id: 'ignored' })
    expect(provider.clientInformation()).toEqual({ client_id: 'g', client_secret: 's' })
  })

  it('opens the browser only for an interactive connect, after registering the state with the loopback', async () => {
    const silent = makeOAuthProvider(1, undefined, false)
    await silent.redirectToAuthorization(new URL('https://auth.test/?state=abc'))
    expect(opened).toEqual([])
    expect(() => silent.getCodePromise()).toThrow('no pending authorization')

    const interactive = makeOAuthProvider(2, { client_id: 'g', client_secret: 's', scope: 'read' })
    await expect(
      interactive.redirectToAuthorization(new URL('https://auth.test/'))
    ).rejects.toThrow('missing state')
    await interactive.redirectToAuthorization(new URL('https://auth.test/?state=xyz'))
    expect(loopback.awaited).toEqual(['xyz'])
    expect(opened[0]).toContain('access_type=offline')
    expect(opened[0]).toContain('scope=read')
    const pending = interactive.getCodePromise()
    loopback.resolve?.('the-code')
    expect(await pending).toBe('the-code')
  })

  it('keeps the PKCE verifier in the provider and clears it on save', () => {
    const provider = makeOAuthProvider(5)
    provider.saveCodeVerifier('v1')
    expect(provider.codeVerifier()).toBe('v1')
    provider.saveTokens({ access_token: 't', token_type: 'bearer' })
    expect(() => provider.codeVerifier()).toThrow()
  })
})
