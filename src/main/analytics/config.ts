/**
 * PostHog project settings. The project is on EU Cloud with "discard client IP" on, GeoIP off,
 * and no autocapture, session replay, feature flags, remote config or surveys (docs/ANALYTICS.md).
 *
 * The project key is public by design (it can only ingest events). An unpackaged build never
 * creates the client, and tests point the client at a fake endpoint, never this host.
 */
export const POSTHOG_API_KEY = 'phc_BwRDGUM5E9wbpBDK62KhicxHPoQrmhRFKQppaZCUrFzU'
export const POSTHOG_HOST = 'https://eu.i.posthog.com'
