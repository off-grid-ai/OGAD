/**
 * Browser APIs that Chromium provides but jsdom does not.
 *
 * This boundary is installed only for DOM test environments. Product components and
 * Radix primitives remain real; the fake owns no timers or subscriptions, and its
 * lifecycle methods are deliberately inert.
 */
import { afterAll, vi } from 'vitest'
// The DOM globals jsdom lacks. One owner, shared with the db suite - see the file.
import './dom-globals.setup'

// Animation frames belong to the DOM that asked for them. Motion (the copy inside
// @offgrid/operator-ui too) captures requestAnimationFrame when it loads, before any test runs, so
// a frame it queued can fire after jsdom has removed `document` at the end of the file, and its
// projection then reads the scroll of a document that is gone ("document is not defined" from
// measureScroll). Frames are tracked here: one that fires with no document does nothing, and the
// ones still queued when the file ends are cancelled. Animations run as they do in the browser.
const browserFrame = globalThis.requestAnimationFrame?.bind(globalThis)
const browserCancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis)
if (browserFrame && browserCancelFrame) {
  const queued = new Set<number>()
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const id = browserFrame((time) => {
      queued.delete(id)
      if (typeof document !== 'undefined') callback(time)
    })
    queued.add(id)
    return id
  }
  globalThis.cancelAnimationFrame = (id: number): void => {
    queued.delete(id)
    browserCancelFrame(id)
  }
  afterAll(() => {
    for (const id of queued) browserCancelFrame(id)
    queued.clear()
  })
}

// motion/react (framer-motion) drives animations off requestAnimationFrame, which
// jsdom stubs — so an AnimatePresence EXIT animation never completes and the
// dismissed element lingers forever, breaking every "overlay is gone after close"
// assertion (image lightbox, viewer modal). Replace motion with a transparent
// passthrough for the DOM harness: motion.* render as their plain host element
// (animation props stripped) and AnimatePresence renders children directly, so
// entrance is instant and exit unmounts immediately — exactly what the user sees
// once the animation finishes. No test asserts intermediate animation values.
vi.mock('motion/react', async () => {
  const React = await import('react')
  const MOTION_PROPS = new Set([
    'initial',
    'animate',
    'exit',
    'transition',
    'variants',
    'whileHover',
    'whileTap',
    'whileInView',
    'whileFocus',
    'whileDrag',
    'layout',
    'layoutId',
    'drag',
    'onAnimationComplete',
    'onAnimationStart',
    'custom'
  ])
  const strip = (props: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(props)) {
      if (!MOTION_PROPS.has(k)) {
        out[k] = v
      }
    }
    return out
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const host = (tag: string): any => {
    const component = React.forwardRef((props: Record<string, unknown>, ref) =>
      React.createElement(tag, { ...strip(props), ref })
    )
    component.displayName = `MotionTest${tag}`
    return component
  }
  // motion.create(Component) wraps a custom component the same way motion.div wraps
  // a host element: render the component itself, animation props stripped.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const create = (Component: any): any => {
    const component = React.forwardRef((props: Record<string, unknown>, ref) =>
      React.createElement(Component, { ...strip(props), ref })
    )
    component.displayName = 'MotionTestCreate'
    return component
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cache = new Map<string, any>()
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) => {
        if (tag === 'create') {
          return create
        }
        if (!cache.has(tag)) {
          cache.set(tag, host(tag))
        }
        return cache.get(tag)
      }
    }
  )
  return {
    motion,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    AnimatePresence: ({ children }: { children: any }) =>
      React.createElement(React.Fragment, null, children),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    MotionConfig: ({ children }: { children: any }) =>
      React.createElement(React.Fragment, null, children),
    useReducedMotion: () => true,
    useAnimate: () => [React.useRef(null), async () => undefined],
    stagger: () => 0
  }
})

/**
 * jsdom loads no stylesheet, so the CSS variable the voice waveform paints with is unset here (in
 * the app its Tailwind class sets `--foreground` on the canvas's parent). The waveform reads it from
 * its canvas on every meter frame, and jsdom (29) resolves an inherited property that no ancestor
 * sets by walking the ancestors again at each level: the cost doubles per level of nesting, about
 * 0.6 s a read at the chat's depth. Set it on <html> so the read finds a value, as it does in
 * Chromium.
 */
if (typeof document !== 'undefined') {
  document.documentElement.style.setProperty('--foreground', 'rgb(52 211 153)')
}

/**
 * jsdom implements no scrolling at all, so Element.scrollIntoView is simply absent - calling it
 * throws. Real browsers always have it. Stub it here rather than guarding each call site, so
 * product code is not shaped around a gap in the test environment.
 */
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {}
}
