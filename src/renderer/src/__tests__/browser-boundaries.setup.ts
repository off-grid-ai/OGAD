/**
 * Browser APIs that Chromium provides but jsdom does not.
 *
 * This boundary is installed only for DOM test environments. Product components and
 * Radix primitives remain real; the fake owns no timers or subscriptions, and its
 * lifecycle methods are deliberately inert.
 */
import { vi } from 'vitest'
// The DOM globals jsdom lacks. One owner, shared with the db suite - see the file.
import './dom-globals.setup'

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
  const host = (tag: string): any =>
    React.forwardRef((props: Record<string, unknown>, ref) =>
      React.createElement(tag, { ...strip(props), ref })
    )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cache = new Map<string, any>()
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) => {
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
    useReducedMotion: () => true
  }
})
