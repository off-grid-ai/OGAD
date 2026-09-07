export type OAuthCredentialScope = 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'

/**
 * Owns the short-lived PKCE verifier for one OAuth provider instance.
 *
 * The MCP SDK invalidates `all` credentials before it retries some token-exchange errors. That
 * retry still uses the same authorization code, so it must also use the same verifier. Explicit
 * verifier invalidation, cancellation, and a successful token save end the attempt.
 */
export class OAuthPkceVerifier {
  private value: string | null = null
  private authorizationActive = false

  save(value: string): void {
    this.value = value
    this.authorizationActive = true
  }

  read(): string {
    if (!this.value) throw new Error('missing PKCE code verifier')
    return this.value
  }

  complete(): void {
    this.clear()
  }

  cancel(): void {
    this.clear()
  }

  invalidate(scope: OAuthCredentialScope): void {
    if (scope === 'verifier' || (scope === 'all' && !this.authorizationActive)) {
      this.clear()
    }
  }

  private clear(): void {
    this.value = null
    this.authorizationActive = false
  }
}
