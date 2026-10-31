// The app's one navigation history: every view change is a browser history entry (a hash route in
// the built app), so Back and Forward (Cmd+[ / Cmd+], the toolbar arrows) are history.back() and
// history.forward(), and popstate restores the view and where the page was scrolled.

/** Views whose own pages are path segments after the view (/video/watch/<id>). */
const PATH_SUBROUTE_VIEWS = new Set(['video'])

export function hasPathSubroute(view: string): boolean {
  return PATH_SUBROUTE_VIEWS.has(view)
}

/** The page's scroll container: the innermost element a page marks `data-route-scroll`, else the
 *  screen wrapper inside the app's content area (`data-route-host`). */
export function routeScroller(): HTMLElement | null {
  const marked = document.querySelectorAll<HTMLElement>('[data-route-scroll]')
  if (marked.length) return marked[marked.length - 1]!
  const host = document.querySelector<HTMLElement>('[data-route-host]')
  return (host?.firstElementChild as HTMLElement | null) ?? null
}

export function routeScrollTop(): number {
  return routeScroller()?.scrollTop ?? 0
}

/** Put the page back where it was. Content can arrive a moment later, so try for a second. */
export function restoreRouteScroll(top: number): void {
  if (!top) return
  const started = performance.now()
  const attempt = (): void => {
    const scroller = routeScroller()
    if (scroller) {
      scroller.scrollTop = top
      if (Math.abs(scroller.scrollTop - top) < 2) return
    }
    if (performance.now() - started < 1000) requestAnimationFrame(attempt)
  }
  requestAnimationFrame(attempt)
}
