import { PostHog } from 'posthog-node'
import type { AnalyticsProperties } from './properties'

/** The two operations the service needs from a PostHog client. */
export interface AnalyticsClient {
  capture(distinctId: string, event: string, properties: AnalyticsProperties): void
  flush(): Promise<void>
  /** Flush what is queued, then stop. */
  shutdown(): Promise<void>
  /** Stop without sending what is queued. */
  discard(): Promise<void>
}

export interface ClientOptions {
  apiKey: string
  host: string
}

const SHUTDOWN_TIMEOUT_MS = 2_000

/**
 * The only place PostHog is constructed. Feature flags, remote config, surveys and exception
 * autocapture stay off; GeoIP is off. Requests go through the global `fetch` at send time, so the
 * offline integration harness sees every one of them.
 *
 * Opt-out must drop the queue, and the SDK's own shutdown always tries to send it. So every
 * request passes a gate: once the client is discarded, the gate answers locally with an empty
 * success and nothing reaches the network.
 */
export function createPostHogClient(options: ClientOptions): AnalyticsClient {
  let dropped = false
  const gate = (async (url: string, init: Parameters<typeof fetch>[1]) => {
    if (dropped) return new Response('{}', { status: 200 })
    return fetch(url, init)
  }) as unknown as NonNullable<ConstructorParameters<typeof PostHog>[1]>['fetch']
  const client = new PostHog(options.apiKey, {
    host: options.host,
    disableGeoip: true,
    enableExceptionAutocapture: false,
    featureFlagsPollingInterval: null,
    flushAt: 20,
    flushInterval: 30_000,
    requestTimeout: 10_000,
    fetchRetryCount: 1,
    fetch: gate
  })
  return {
    capture(distinctId, event, properties) {
      if (dropped) return
      client.capture({ distinctId, event, properties, disableGeoip: true })
    },
    flush: () => (dropped ? Promise.resolve() : client.flush().catch(() => {})),
    shutdown: () => client.shutdown(SHUTDOWN_TIMEOUT_MS).catch(() => {}),
    discard: () => {
      dropped = true
      return client.shutdown(SHUTDOWN_TIMEOUT_MS).catch(() => {})
    }
  }
}
