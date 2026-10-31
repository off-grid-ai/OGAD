import type http from 'node:http'

/** One authenticated gateway request, with the gateway's own body and JSON helpers. */
export interface GatewayRouteContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  url: string
  method: string
  rid: string
  /** The request's query string; `url` has none. */
  query: URLSearchParams
  readJson(): Promise<Record<string, unknown>>
  /** A multipart/form-data body: its text fields and uploaded files. */
  readForm(): Promise<{
    fields: Record<string, string>
    files: Record<string, { filename: string; data: Buffer }>
  }>
  json(status: number, body: unknown): void
}

/** Returns true when it answered the request. Pro registers routes; core never imports them. */
export type GatewayRoute = (context: GatewayRouteContext) => boolean | Promise<boolean>

const routes = new Set<GatewayRoute>()

export function registerGatewayRoute(route: GatewayRoute): () => void {
  routes.add(route)
  return () => {
    routes.delete(route)
  }
}

export async function dispatchGatewayRoute(context: GatewayRouteContext): Promise<boolean> {
  for (const route of routes) if (await route(context)) return true
  return false
}

/** Paths that exist only with Pro, and the feature each one is. Without Pro the gateway refuses
 *  them with 402, not 404. */
const PRO_GATEWAY_FEATURES: Record<string, string> = {
  '/v1/videos': 'Video',
  '/v1/stories': 'Video',
  '/v1/search': 'Search',
  '/v1/writing': 'Scribe'
}

/** The Pro feature a path belongs to, or null when the path is not Pro-only. */
export function proGatewayFeature(url: string): string | null {
  for (const [prefix, feature] of Object.entries(PRO_GATEWAY_FEATURES))
    if (url === prefix || url.startsWith(`${prefix}/`)) return feature
  return null
}
