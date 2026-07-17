export const HOST_OWNED_ROUTES = [
  'dashboard',
  'day',
  'replay',
  'reflect',
  'actions',
  'connectors',
  'meetings',
  'chats',
  'memories',
  'entities',
  'graph',
  'memory-chat',
  'models',
  'gateway',
  'projects',
  'notifications',
  'settings',
  'search',
  'clipboard',
  'voice',
  'vault'
] as const

export type CoreViewMode = (typeof HOST_OWNED_ROUTES)[number]

const hostOwnedRouteSet: ReadonlySet<string> = new Set(HOST_OWNED_ROUTES)

export function isHostOwnedRoute(route: string): route is CoreViewMode {
  return hostOwnedRouteSet.has(route)
}
