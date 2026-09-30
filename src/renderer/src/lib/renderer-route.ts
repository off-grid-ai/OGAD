type RouteLocation = Pick<Location, 'protocol' | 'hash' | 'pathname'>

export function rendererRoute(location: RouteLocation, fallback = ''): string {
  return location.protocol === 'file:' ? location.hash.slice(1) || fallback : location.pathname
}

export function rendererRouteTarget(location: RouteLocation, route: string): string {
  return location.protocol === 'file:' ? `#${route}` : route
}

export function replaceRendererRoute(
  location: RouteLocation,
  history: Pick<History, 'replaceState'>,
  route: string
): void {
  if (rendererRoute(location) !== route)
    history.replaceState(null, '', rendererRouteTarget(location, route))
}
