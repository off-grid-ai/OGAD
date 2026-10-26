import type http from 'node:http'

/** One authenticated gateway request, with the gateway's own body and JSON helpers. */
export interface GatewayRouteContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  url: string
  method: string
  rid: string
  readJson(): Promise<Record<string, unknown>>
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

/** Paths that exist only with Pro. Without it the gateway refuses them with 402, not 404. */
export const PRO_GATEWAY_PATHS = ['/v1/videos', '/v1/stories'] as const

export function isProGatewayPath(url: string): boolean {
  return PRO_GATEWAY_PATHS.some((prefix) => url === prefix || url.startsWith(`${prefix}/`))
}
