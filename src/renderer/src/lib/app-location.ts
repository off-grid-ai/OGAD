/** Keep the renderer HTML path intact so packaged app reloads work. */
export function appLocationPath(): string {
  return window.location.protocol === 'file:'
    ? window.location.hash.slice(1) || '/'
    : window.location.pathname
}

export function replaceAppLocation(path: string): void {
  window.history.replaceState(null, '', window.location.protocol === 'file:' ? `#${path}` : path)
}
