import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

// How close to the end still counts as "at the bottom", so a pixel of rounding never unpins it.
const BOTTOM_SLACK_PX = 24

function atBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX
}

/** Keeps the scrollable element matching `selector` inside `containerRef` at its end as
 *  `content` grows, but only while the person is already at the end. Scrolling up stops
 *  the follow; scrolling back to the end starts it again. */
export function useFollowScrollBottom(
  containerRef: RefObject<HTMLElement | null>,
  selector: string,
  content: string
): void {
  // Whether the element sat at its end before the latest content arrived.
  const pinnedRef = useRef(true)

  useEffect(() => {
    // Capture on the document: scroll does not bubble, and the frame and its element are
    // remounted when the artifact's kind or tab changes.
    const onScroll = (event: Event): void => {
      const target = event.target
      if (
        target instanceof HTMLElement &&
        target.matches(selector) &&
        containerRef.current?.contains(target)
      ) {
        pinnedRef.current = atBottom(target)
      }
    }
    document.addEventListener('scroll', onScroll, true)
    return () => document.removeEventListener('scroll', onScroll, true)
  }, [containerRef, selector])

  useLayoutEffect(() => {
    const el = containerRef.current?.querySelector<HTMLElement>(selector)
    if (!el) return
    if (pinnedRef.current) el.scrollTop = el.scrollHeight
    pinnedRef.current = atBottom(el)
  }, [containerRef, selector, content])
}
