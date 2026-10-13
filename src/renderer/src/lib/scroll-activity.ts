// Scroll bars show only while an area is scrolling. CSS alone can show a scroll bar on hover, not
// on scroll, so this marks whatever is scrolling with data-scrolling and clears it a moment after
// it stops; main.css paints the thumb only on marked areas. One capture-phase listener covers
// every scroll area in the window, however deep.

/** How long after the last scroll the bar stays, so it does not flicker between wheel ticks. */
export const SCROLL_BAR_LINGER_MS = 800

const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>()

function markScrolling(target: EventTarget | null): void {
  const element =
    target instanceof Document ? target.documentElement : target instanceof Element ? target : null
  if (!element) return
  element.setAttribute('data-scrolling', '')
  const pending = timers.get(element)
  if (pending) clearTimeout(pending)
  timers.set(
    element,
    setTimeout(() => {
      element.removeAttribute('data-scrolling')
      timers.delete(element)
    }, SCROLL_BAR_LINGER_MS)
  )
}

/** Wire the listener once, before first paint. Returns what removes it. */
export function initScrollActivity(target: Document = document): () => void {
  const onScroll = (event: Event): void => markScrolling(event.target)
  target.addEventListener('scroll', onScroll, { capture: true, passive: true })
  return () => target.removeEventListener('scroll', onScroll, { capture: true })
}
