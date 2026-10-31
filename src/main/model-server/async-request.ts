// Pure async-request detection + poll-URL / route shaping. No I/O.
// Extracted from model-server.ts so the "did the caller ask for async?" decision
// (query, header, Prefer, body, form field), the RESTful poll URL, and the
// per-collection poll-route matcher are unit-testable and defined once.

// Collections whose `<collection>/{id}` GET path resolves to a request resource.
export const POLL_COLLECTIONS = [
  '/v1/videos',
  '/v1/images',
  '/v1/images/generations',
  '/v1/images/edits',
  '/v1/chat/completions',
  '/v1/embeddings',
  '/v1/audio/speech',
  '/v1/audio/transcriptions'
]

/** The minimal request-shaped inputs isAsync needs (no http types). */
export interface AsyncSignals {
  url?: string
  headers?: Record<string, unknown>
}

/**
 * Did the caller ask for async handling? Opt in via `?async=true`, header
 * `X-Async: true`, `Prefer: respond-async`, body `"async": true`, or form field
 * `async=true`.
 */
export function isAsync(
  req: AsyncSignals,
  payload?: Record<string, unknown>,
  fields?: Record<string, string>
): boolean {
  const q = (req.url || '').split('?')[1] || ''
  if (/(^|&)async=(1|true|yes)(&|$)/i.test(q)) return true
  const h = String(req.headers?.['x-async'] || '').toLowerCase()
  if (h === 'true' || h === '1') return true
  if (/respond-async/i.test(String(req.headers?.prefer || ''))) return true
  if (payload && payload.async === true) return true
  if (fields && /^(1|true|yes)$/i.test(fields.async || '')) return true
  return false
}

/** The RESTful poll URL for a request resource. */
export function pollUrl(collection: string, id: string): string {
  return `${collection}/${id}`
}

/**
 * Split a GET url into the collection prefix + trailing id, and report whether
 * that prefix is a poll collection. Mirrors the routing in the request handler.
 */
export function matchPollRoute(url: string): {
  prefix: string
  id: string
  isPollCollection: boolean
} {
  const slash = url.lastIndexOf('/')
  const prefix = url.slice(0, slash)
  const id = url.slice(slash + 1)
  return { prefix, id, isPollCollection: POLL_COLLECTIONS.includes(prefix) }
}
