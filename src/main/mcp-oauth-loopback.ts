import http from 'http'
import { IMAGE_MIME } from '@offgrid/models'

interface PendingAuthorization {
  resolve: (code: string) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface OAuthLoopbackOptions {
  port: number
  host?: string
  authorizationTimeoutMs?: number
  renderCompletionPage: (error: string | null) => string
  logoBytes?: () => Buffer | null
  onError?: (error: Error) => void
  onListening?: (port: number) => void
}

const INVALID_RESPONSE = 'Invalid or expired authorization response'

/**
 * Owns the OAuth callback listener and the complete lifecycle of pending states.
 * A state is admitted once, matched exactly, and removed before it is settled.
 */
export class OAuthLoopbackServer {
  private readonly host: string
  private readonly authorizationTimeoutMs: number
  private readonly pendingByState = new Map<string, PendingAuthorization>()
  private server: http.Server | null = null
  private startPromise: Promise<void> | null = null

  constructor(private readonly options: OAuthLoopbackOptions) {
    this.host = options.host ?? '127.0.0.1'
    this.authorizationTimeoutMs = options.authorizationTimeoutMs ?? 3 * 60 * 1000
  }

  get redirectUrl(): string {
    const address = this.server?.address()
    const port = typeof address === 'object' && address ? address.port : this.options.port
    return `http://${this.host}:${port}/callback`
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise

    const server = http.createServer((request, response) => this.handleRequest(request, response))
    this.server = server
    this.startPromise = new Promise<void>((resolve, reject) => {
      const handleStartupError = (error: Error): void => {
        this.server = null
        this.startPromise = null
        this.rejectAll(new Error('OAuth callback server unavailable'))
        this.options.onError?.(error)
        reject(error)
      }

      server.once('error', handleStartupError)
      server.listen(this.options.port, this.host, () => {
        server.off('error', handleStartupError)
        server.on('error', (error) => {
          this.options.onError?.(error)
          this.rejectAll(new Error('OAuth callback server unavailable'))
        })
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : this.options.port
        this.options.onListening?.(port)
        resolve()
      })
    })

    return this.startPromise
  }

  awaitCode(state: string, timeoutMs = this.authorizationTimeoutMs): Promise<string> {
    if (!state) throw new Error('OAuth authorization URL is missing state')
    if (this.pendingByState.has(state)) {
      throw new Error('OAuth authorization state is already pending')
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.takePending(state)
        pending?.reject(new Error('Authorization timed out'))
      }, timeoutMs)
      this.pendingByState.set(state, { resolve, reject, timer })
    })
  }

  cancel(state: string, error: Error): void {
    this.takePending(state)?.reject(error)
  }

  async stop(): Promise<void> {
    this.rejectAll(new Error('OAuth callback server stopped'))
    const server = this.server
    this.server = null
    this.startPromise = null
    if (!server?.listening) return
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }

  private handleRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
    const url = new URL(request.url ?? '', this.redirectUrl)
    if (url.pathname === '/oglogo.png') {
      this.serveLogo(response)
      return
    }
    if (url.pathname !== '/callback') {
      response.writeHead(404)
      response.end()
      return
    }

    const state = url.searchParams.get('state')
    const pending = state ? this.takePending(state) : undefined
    if (!pending) {
      this.respond(response, 400, INVALID_RESPONSE)
      return
    }

    const providerError = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    if (providerError) {
      this.respond(response, 200, providerError)
      pending.reject(new Error(`OAuth error: ${providerError}`))
      return
    }
    if (!code) {
      this.respond(response, 400, 'No authorization code in redirect')
      pending.reject(new Error('No authorization code in redirect'))
      return
    }

    this.respond(response, 200, null)
    pending.resolve(code)
  }

  private takePending(state: string): PendingAuthorization | undefined {
    const pending = this.pendingByState.get(state)
    if (!pending) return undefined
    this.pendingByState.delete(state)
    clearTimeout(pending.timer)
    return pending
  }

  private rejectAll(error: Error): void {
    for (const state of [...this.pendingByState.keys()]) {
      this.takePending(state)?.reject(error)
    }
  }

  private serveLogo(response: http.ServerResponse): void {
    const bytes = this.options.logoBytes?.()
    if (!bytes) {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, { 'Content-Type': IMAGE_MIME.png })
    response.end(bytes)
  }

  private respond(response: http.ServerResponse, status: number, error: string | null): void {
    response.writeHead(status, { 'Content-Type': 'text/html' })
    response.end(this.options.renderCompletionPage(error))
  }
}
